/**
 *
 * @example
 * ```ts
 * import log, { createLog } from '@lickle/trace/log'
 * import { defaultTrace } from '@lickle/trace'
 *
 * // The default logger is bound to the default trace...
 * log.info('Hello, world!')
 *
 * // ...or bind one explicitly to any trace, with context of its own.
 * const custom = createLog(defaultTrace, { service: 'api' })
 * custom.info('Hello, world!')
 *
 * // Context can also come from a hook, which may extend the surface.
 * const counted = custom.with(hook(() => ({ ext: { ping: () => 'pong' } })))
 * counted.ping()
 * ```
 */
import { Level, type Fields, type Layer, type Span, type Trace } from './types.ts'
import defaultTrace from './trace.ts'

/**
 * A leveled log function — the equivalent of Rust `tracing`'s event macros
 * (`info!`, `warn!`, ...), bound to a {@link Trace}.
 *
 * @example
 * ```ts
 * info`Processing request with id ${requestId}`
 * info({ requestId: '123' }, 'Processing request.')
 * info({ requestId: '123' })`Processing request.`
 * info('Application started successfully.')
 * error(new Error('boom'))
 * ```
 */
export type LogFn = {
  /** Logs a message using template literals with interpolated values. */
  (template: { raw: readonly string[] | ArrayLike<string> }, ...substitutions: any[]): void

  /** Logs a message with attached metadata fields. */
  (fields: Record<string, any>, ...messages: MessageParts): void

  /**
   * Attaches metadata fields, returning a function that logs the message.
   * Note: nothing is emitted until the returned function is called.
   */
  (fields: Record<string, any>): {
    (template: { raw: readonly string[] | ArrayLike<string> }, ...substitutions: any[]): void
    (...messages: MessageParts): void
  }

  /** Logs a simple message (or an Error, capturing its stack as fields). */
  (...messages: MessageParts): void
}

type MessagePrimitivePart = string | number | null | boolean
type MessageParts = [Error, ...MessagePrimitivePart[]] | MessagePrimitivePart[]

/**
 * A span-creating function — the equivalent of `span!`. With a callback it
 * runs the callback inside the span via `trace.scope` (so it is contained
 * under async-aware registries) and ends it on return/settle; without one it
 * returns the entered {@link Span} to end manually (prefer `using`).
 *
 * @example
 * ```ts
 * span('process-request', { requestId }, async () => { ... })
 * span('process-request', () => { ... })
 * using sp = span('process-request')
 * ```
 */
export type SpanFn = {
  <R>(name: string, fields: Record<string, any> | undefined | null, fn: (span: Span) => R): R
  <R>(name: string, fn: (span: Span) => R): R
  (name: string, fields?: Record<string, any> | undefined | null): Span
}

/**
 * A {@link SpanFn} (INFO when called directly) with per-level variants —
 * the equivalents of `trace_span!` ... `error_span!`.
 *
 * @example
 * ```ts
 * span('operation', () => { ... })        // INFO
 * span.debug('operation', () => { ... })  // DEBUG
 * ```
 */
export type LeveledSpanFn = SpanFn & {
  trace: SpanFn
  debug: SpanFn
  info: SpanFn
  warn: SpanFn
  error: SpanFn
}

/**
 * The macro surface of the library: leveled event functions and span
 * creation, bound to one {@link Trace} — the equivalent of importing Rust
 * `tracing`'s macros. Not a logger: there is no name hierarchy; context is
 * carried by fields ({@link LogCore.with}) and by spans, as in `tracing`.
 */
export interface LogCore<H extends readonly HookLike[] = []> {
  /** TRACE-level event (`trace!`). */
  trace: LogFn
  /** DEBUG-level event (`debug!`). */
  debug: LogFn
  /** INFO-level event (`info!`). */
  info: LogFn
  /** WARN-level event (`warn!`). */
  warn: LogFn
  /** ERROR-level event (`error!`). */
  error: LogFn
  /** Span creation (`span!` / `*_span!`). */
  span: LeveledSpanFn
  /**
   * Derive a {@link Log} carrying more context — the `tracing` idiom of
   * attaching context as fields rather than logger names. Takes fields to
   * merge into everything it emits, or a {@link Hook} that may also extend
   * the surface. Derivations compose: `log.with(a).with(b)` carries both,
   * with `b` winning on conflicting keys and call-site fields winning over
   * both.
   */
  with<K extends HookLike>(hook: K): Log<[...H, K]>
}

/** A {@link LogCore} plus every member its hooks contribute through `ext`. */
export type Log<H extends readonly HookLike[] = []> = LogCore<H> & Merge<ExtOf<H[number]>>

/**
 * An extension of a {@link Log}, invoked once per derivation with the log it
 * is attached to and that log's trace, so it can hold private state in a
 * closure.
 *
 * Emission itself is not a hook concern — filtering and routing belong to a
 * {@link Layer}, which sees levels and spans as well.
 *
 * @example
 * ```ts
 * const elapsed = hook((_, trace) => {
 *   const start = trace.context.now()
 *   return {
 *     fields: (fields) => ({ ...fields, uptime: trace.context.now() - start }),
 *     ext: { since: () => start },
 *   }
 * })
 *
 * const log = createLog(defaultTrace, elapsed)
 * log.info('served') // fields: { uptime: 12.5 }
 * log.since()        // typed, contributed by the hook
 * ```
 */
export type Hook = (
  self: Log<any>,
  trace: Trace,
) => {
  /** Transform the fields the log carries, applied in derivation order. */
  fields?: (fields: Fields) => Fields
  /** Members merged onto the log. {@link LogCore} keys are reserved. */
  ext?: Ext
}

/** A {@link Hook}, or a plain fields object as sugar for one. */
export type HookLike = Hook | Fields

/** Hook-contributed members. Shadowing a {@link LogCore} member is an error. */
export type Ext = Record<string, any> & { [K in keyof LogCore]?: never }

/** Identity, so a {@link Hook} defined standalone gets its parameter types. */
export const hook = <K extends Hook>(h: K): K => h

type ExtOf<T> = T extends (...args: any[]) => { ext: infer E } ? E : {}
type Merge<U> = (U extends any ? (u: U) => void : never) extends (u: infer I) => void ? I : unknown

/**
 * Create a {@link Log} bound to `trace` (default: the global trace). Each
 * hook — or plain fields object — contributes context to every event and span
 * it emits.
 */
export const createLog = <H extends readonly HookLike[]>(trace: Trace = defaultTrace, ...hooks: H): Log<H> => {
  const lgr = {} as any
  const hks: ReturnType<Hook>[] = []

  // Resolved per emit, so a hook's fields may reflect state that has since
  // moved on (elapsed time, the request in flight).
  const carried = (fields?: Fields) => hks.reduce((fields, h) => h.fields?.(fields) ?? fields, fields ?? ({} as Fields))

  const logFn = (level: Level, extra?: Fields): LogFn => {
    const source = captureSource(logFn)

    const emit = (message: string, fields?: Fields) =>
      trace.event(message, level, carried({ source, ...extra, ...fields }))

    return function log(a: any, ...subs: any[]): any {
      // Template literal: info`msg ${x}`
      if (Array.isArray(a) && Array.isArray((a as any).raw)) {
        return emit(String.raw(a as any, ...subs))
      }

      let extraFields: Fields = {}
      let parts: MessageParts = []

      // Errors: error(err) — capture stack/name/cause as fields
      if (a instanceof Error) {
        extraFields = { stack: a.stack, name: a.name, cause: a.cause }
        parts.push(a.message)
      }

      // Field objects: emit immediately when a message accompanies the
      // fields, otherwise return a carrying log function. Beware: a bare
      // `info({ ... })` emits nothing until the returned function is called.
      else if (a != null && typeof a === 'object' && !Array.isArray(a)) {
        extraFields = { ...extraFields, ...a }
        if (subs.length === 0) return logFn(level, { ...extra, ...extraFields })
      } else {
        parts.push(a)
      }
      parts.push(...subs)

      return emit(parts.join(' '), { ...extra, ...extraFields })
    } as LogFn
  }

  const spanFn = (level: Level): SpanFn =>
    function span(
      name: string,
      fields?: Fields | undefined | null | ((span: Span) => unknown),
      fn2?: (span: Span) => unknown,
    ): any {
      const fn = typeof fields === 'function' ? fields : fn2
      const merged = typeof fields === 'function' || fields == null ? carried() : { ...carried(), ...fields }
      if (!fn) return trace.span(name, level, merged)
      return trace.scope(name, fn, level, merged)
    } as SpanFn

  Object.assign(lgr, {
    trace: logFn(Level.TRACE),
    debug: logFn(Level.DEBUG),
    info: logFn(Level.INFO),
    warn: logFn(Level.WARN),
    error: logFn(Level.ERROR),
    span: Object.assign(spanFn(Level.INFO), {
      trace: spanFn(Level.TRACE),
      debug: spanFn(Level.DEBUG),
      info: spanFn(Level.INFO),
      warn: spanFn(Level.WARN),
      error: spanFn(Level.ERROR),
    }),
    with: (h: HookLike) => createLog(trace, ...hooks, h),
  })

  // `ext` lands only once every hook has run, so a hook may reference members
  // contributed by its peers when its own functions are called.
  for (const h of hooks) hks.push((typeof h === 'function' ? h : fieldsHook(h))(lgr, trace))
  for (const h of hks) Object.assign(lgr, h.ext)

  return lgr as Log<H>
}

type AnyFn = (...args: any[]) => any

Error.stackTraceLimit = Infinity
const captureSource = (target: AnyFn) => {
  const err = new Error()
  ;(Error as { captureStackTrace?: (target: object, ctor?: AnyFn) => void }).captureStackTrace?.(err, target)
  const stack = err.stack?.split('\n') ?? []
  const frame = stack.slice(1)[0]
  return /\((.*)\)/.exec(frame ?? '')?.[1]?.trim()
}

/** Fields sugar: later derivations win, and call-site fields win over all. */
const fieldsHook =
  (fields: Fields): Hook =>
  () => ({ fields: (carried) => ({ ...carried, ...fields }) })

/** The default {@link Log}, bound to the default trace. */
const log: Log = createLog()
export default log

// Free, tree-shakeable macro equivalents bound to the default trace —
// `import { info, span } from '@lickle/trace/log'` mirrors `use tracing::info`.
// `trace` here is the TRACE-level event fn (`tracing::trace!`), not a Trace
// instance — the default Trace is exported from the package root as
// `defaultTrace`, so the two never collide.
export const trace: LogFn = log.trace
export const debug: LogFn = log.debug
export const info: LogFn = log.info
export const warn: LogFn = log.warn
export const error: LogFn = log.error
export const span: LeveledSpanFn = log.span
