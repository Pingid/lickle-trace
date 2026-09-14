import { severity, type Fields, type Layer, type Level } from './types.ts'

// `Symbol.dispose` may be absent on older runtimes (some wasm hosts, older
// Safari). Polyfill it here — this module loads before any span is created —
// so `using` and the `[Symbol.dispose]` method work on every entrypoint.
if (!(Symbol as { dispose?: symbol }).dispose) {
  ;(Symbol as { dispose?: symbol }).dispose = Symbol.for('Symbol.dispose')
}

const g: { crypto?: Crypto; performance?: Performance } = globalThis as never

const randomHex = (bytes: number): string => {
  let s = ''
  for (let i = 0; i < bytes; i++) s += ((Math.random() * 256) | 0).toString(16).padStart(2, '0')
  return s
}

/**
 * Unique id for traces, spans, and events alike.
 *
 * The shape is opaque — nothing in the core depends on it. `@lickle/trace/propagate`
 * derives spec-shaped 16-byte trace / 8-byte span ids from these at the wire
 * boundary, so no wire format leaks into the core.
 */
export const uid = (): string =>
  g.crypto?.randomUUID ? g.crypto.randomUUID() : `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(6)}`

/**
 * Wall-clock time in milliseconds since the Unix epoch.
 *
 * Uses `performance.timeOrigin + performance.now()` where available: it is
 * sub-millisecond precise and monotonic within a session, so the same reading
 * serves both timestamps and durations. Falls back to `Date.now()`.
 */
export const now = (): number => (g.performance?.now ? g.performance.timeOrigin + g.performance.now() : Date.now())

/** Checks whether a level passes a layer's `minLevel` floor. */
export const enabled = (level: Level, layer?: Layer): boolean =>
  severity[level] >= (layer?.minLevel ? severity[layer.minLevel] : 0)

/**
 * Normalize a thrown value into fields. Used when a `scope` callback rejects
 * or throws, so a failed span carries its cause rather than exiting silently.
 */
export const errorFields = (err: unknown): Fields =>
  err instanceof Error
    ? { error: { name: err.name, message: err.message, stack: err.stack, cause: err.cause } }
    : { error: err }
