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
 * // ...or bind one explicitly to any trace.
 * const custom = createLog(defaultTrace, { service: 'api' })
 * custom.info('Hello, world!')
 * ```
 */
import { Level, type Fields, type Span, type Trace } from './types.ts'
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
  (fields: Record<string, any>, message: string | number | null | boolean | Error): void

  /**
   * Attaches metadata fields, returning a function that logs the message.
   * Note: nothing is emitted until the returned function is called.
   */
  (fields: Record<string, any>): {
    (template: { raw: readonly string[] | ArrayLike<string> }, ...substitutions: any[]): void
    (message: string | number | null | boolean | Error): void
  }

  /** Logs a simple message (or an Error, capturing its stack as fields). */
  (message: string | number | null | boolean | Error): void
}

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
 * carried by fields ({@link Log.with}) and by spans, as in `tracing`.
 */
export interface Log {
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
   * Derive a {@link Log} whose fields are merged into everything it emits —
   * the `tracing` idiom of attaching context as fields rather than logger
   * names. Derivations compose: `log.with(a).with(b)` merges both.
   */
  with(fields: Fields): Log
}

/**
 * Create a {@link Log} bound to `trace` (default: the global trace), with
 * `meta` merged into every event and span it emits.
 */
export const createLog = (trace: Trace = defaultTrace, meta: Fields = {}): Log => {
  const logFn = (level: Level, extra?: Fields): LogFn => {
    const emit = (message: string, fields?: Fields) => trace.event(message, level, { ...meta, ...extra, ...fields })

    return function log(a: any, ...subs: any[]): any {
      // Template literal: info`msg ${x}`
      if (Array.isArray(a) && Array.isArray((a as any).raw)) {
        return emit(String.raw(a as any, ...subs))
      }

      // Primitives: info('msg')
      if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean' || a === null) {
        return emit(String(a))
      }

      // Errors: error(err) — capture stack/name/cause as fields
      if (a instanceof Error) {
        return emit(a.message, { stack: a.stack, name: a.name, cause: a.cause })
      }

      // Field objects: emit immediately when a message accompanies the
      // fields, otherwise return a carrying log function. Beware: a bare
      // `info({ ... })` emits nothing until the returned function is called.
      if (typeof a === 'object' && !Array.isArray(a)) {
        const carried = logFn(level, { ...extra, ...a })
        return subs.length > 0 ? carried(subs[0]) : carried
      }

      // Everything else
      return emit(JSON.stringify(a))
    } as LogFn
  }

  const spanFn = (level: Level): SpanFn =>
    function span(
      name: string,
      fields?: Fields | undefined | null | ((span: Span) => unknown),
      fn2?: (span: Span) => unknown,
    ): any {
      const fn = typeof fields === 'function' ? fields : fn2
      const merged = typeof fields === 'function' || fields == null ? { ...meta } : { ...meta, ...fields }
      if (!fn) return trace.span(name, level, merged)
      return trace.scope(name, fn, level, merged)
    } as SpanFn

  return {
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
    with: (fields: Fields) => createLog(trace, { ...meta, ...fields }),
  }
}

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
