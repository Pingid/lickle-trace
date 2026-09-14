/**
 * W3C Trace Context propagation — carry a trace across a service boundary.
 *
 * The core's ids are opaque strings; the wire format wants 16-byte trace ids
 * and 8-byte span ids as lowercase hex. This module does that translation at
 * the boundary, and nowhere else, so no wire shape leaks into the core.
 *
 * @example
 * ```ts
 * // caller
 * const headers = new Headers()
 * inject(trace.current(), headers)
 * await fetch(url, { headers })
 *
 * // callee
 * await withRemoteParent(trace, request.headers, 'GET /users', async () => {
 *   // spans in here inherit the caller's traceId and parent onto its span
 * })
 * ```
 */
import { Level, type Span, type Trace } from './types.ts'
import { linkSpan } from './trace.ts'

/** @see https://www.w3.org/TR/trace-context/#traceparent-header */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

/** Anything header-shaped: `Headers`, a plain object, a Map-like. */
export interface Carrier {
  get?(name: string): string | null | undefined
  set?(name: string, value: string): void
  [key: string]: unknown
}

const read = (carrier: Carrier, name: string): string | undefined => {
  const viaGet = typeof carrier.get === 'function' ? carrier.get(name) : undefined
  const value = viaGet ?? carrier[name] ?? carrier[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

const write = (carrier: Carrier, name: string, value: string): void => {
  if (typeof carrier.set === 'function') carrier.set(name, value)
  else carrier[name] = value
}

const isHex = (value: string, length: number): boolean => value.length === length && /^[0-9a-f]+$/.test(value)

/**
 * Expand an opaque id to `bytes` of lowercase hex, deterministically.
 *
 * Idempotent by design: an id that is *already* the right width of hex is
 * returned untouched, so an id received over the wire and sent on again is
 * unchanged and the trace stays joined across any number of hops.
 */
const toHex = (value: string, bytes: number): string => {
  if (isHex(value, bytes * 2)) return value
  let out = ''
  let h = 0x811c9dc5
  for (let i = 0; out.length < bytes * 2; i++) {
    for (let j = 0; j < value.length; j++) h = Math.imul(h ^ value.charCodeAt(j), 0x01000193)
    h = Math.imul(h ^ i, 0x01000193)
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, bytes * 2)
}

/** The span's trace id in W3C form (32 lowercase hex chars). */
export const traceIdOf = (span: Span): string => toHex(span.traceId, 16)

/** The span's own id in W3C form (16 lowercase hex chars). */
export const spanIdOf = (span: Span): string => toHex(span.id, 8)

/**
 * Write `span` into `carrier` as a `traceparent` header. A `undefined` span
 * (nothing active) writes nothing, so this is safe to call unconditionally.
 */
export const inject = (span: Span | undefined, carrier: Carrier): void => {
  if (!span || span.id === '') return
  write(carrier, 'traceparent', `00-${traceIdOf(span)}-${spanIdOf(span)}-01`)
}

/** The remote context a `traceparent` header carries. */
export interface RemoteContext {
  traceId: string
  parentId: string
  sampled: boolean
}

/** Parse a `traceparent` header out of `carrier`, if it has a valid one. */
export const extract = (carrier: Carrier): RemoteContext | undefined => {
  const match = TRACEPARENT.exec(read(carrier, 'traceparent') ?? '')
  if (!match) return undefined
  return { traceId: match[1]!, parentId: match[2]!, sampled: (parseInt(match[3]!, 16) & 1) === 1 }
}

/**
 * Make the remote parent named by `carrier` current, so everything opened
 * under it inherits the caller's `traceId` and parents onto its span.
 *
 * The span is linked, not adopted: it is not announced to the layer, because
 * the caller has already reported it. Returns `undefined` when the carrier has
 * no usable `traceparent`. Release it with `trace.context.spans.remove(span)`
 * when the incoming request finishes — {@link withRemoteParent} is the scoped
 * form and is usually what you want.
 */
export const linkRemote = (trace: Trace, carrier: Carrier, name = 'remote'): Span | undefined => {
  const remote = extract(carrier)
  if (!remote) return undefined
  return linkSpan(trace, {
    type: 'span',
    id: remote.parentId,
    traceId: remote.traceId,
    name,
    level: Level.INFO,
    timestamp: trace.context.now(),
  })
}

/**
 * Run `fn` in a span named `name`, parented to the remote span described by
 * `carrier` and sharing its trace id.
 *
 * With no usable `traceparent` this is just `trace.scope(name, fn)`, so a
 * request from an uninstrumented caller still works — it simply starts a new
 * trace. The remote link is released when `fn` returns or settles.
 *
 * @example
 * ```ts
 * server.on('request', (req, res) =>
 *   withRemoteParent(trace, req.headers, `${req.method} ${req.url}`, async () => handle(req, res)),
 * )
 * ```
 */
export const withRemoteParent = <T>(trace: Trace, carrier: Carrier, name: string, fn: (span: Span) => T): T =>
  trace.context.spans.run(() => {
    const remote = linkRemote(trace, carrier, `${name} (caller)`)
    const release = (): void => void (remote && trace.context.spans.remove(remote))

    let result: unknown
    try {
      result = trace.scope(name, fn)
    } catch (err) {
      release()
      throw err
    }

    // Hold the link until an async body settles, not just until it returns.
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(result).then(
        (value) => {
          release()
          return value
        },
        (err: unknown) => {
          release()
          throw err
        },
      ) as T
    }

    release()
    return result as T
  })
