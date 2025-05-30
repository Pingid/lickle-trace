import { defaultTrace, Fields, Level, Trace } from './trace.js'

/**
 * Represents a logging event that can handle template literals, metadata, and simple messages.
 * @example
 * logger.log`Processing request with id ${requestId}`;
 * logger.log({ requestId: '12345' })`Processing request.`;
 * logger.log('Application started successfully.');
 */
type LoggerEvent = {
  /**
   * Logs a message using template literals with interpolated strings.
   * @example
   * logger.log`Processing request with id ${requestId}`;
   */
  (template: { raw: readonly string[] | ArrayLike<string> }, ...substitutions: any[]): void

  /**
   * Logs a message with additional metadata for structured logging.
   * @example
   * logger.log({ requestId: '12345' })`Processing request.`;
   */
  (meta: Record<string, any>): {
    (template: { raw: readonly string[] | ArrayLike<string> }, ...substitutions: any[]): void
    (message: string | number | null | boolean | Error): void
  }

  /**
   * Logs a simple message without interpolation.
   * @example
   * logger.log('Application started successfully.');
   */
  (message: string | number | null | boolean | Error): void
}

/**
 * Represents a span for tracking operations with different log levels.
 * @example
 * logger.span('process-request', { requestId: '123' }, async () => {
 *   // do work
 * });
 */
type LoggerSpan = {
  /**
   * Creates a span with metadata and executes a function within it.
   * @example
   * logger.span('process-request', { requestId: '123' }, async () => {
   *   // do work
   * });
   */
  <R>(name: string, meta: Record<string, any> | undefined | null, fn: () => R): R

  /**
   * Creates a span and executes a function within it.
   * @example
   * logger.span('process-request', async () => {
   *   // do work
   * });
   */
  <R>(name: string, fn: () => R): R

  /**
   * Creates a span with metadata and returns an object with an exit method.
   * @example
   * const span = logger.span('process-request', { requestId: '123' });
   * try {
   *   // do work
   * } finally {
   *   span.exit();
   * }
   */
  (name: string, meta: Record<string, any> | undefined | null): { exit: () => void }

  /**
   * Creates a span and returns an object with an exit method.
   * @example
   * const span = logger.span('process-request');
   * try {
   *   // do work
   * } finally {
   *   span.exit();
   * }
   */
  (name: string): { exit: () => void }

  /** Creates spans at TRACE level */
  trace: LoggerSpan
  /** Creates spans at DEBUG level */
  debug: LoggerSpan
  /** Creates spans at INFO level */
  info: LoggerSpan
  /** Creates spans at WARN level */
  warn: LoggerSpan
  /** Creates spans at ERROR level */
  error: LoggerSpan
}

/**
 * A logger instance that provides structured logging with different levels and spans.
 * @example
 * const logger = new Logger(trace);
 * logger.info`Processing request ${requestId}`;
 * logger.span('operation', async () => {
 *   // do work
 * });
 */
export class Logger {
  public meta: Record<string, any> = {}
  public span: LoggerSpan
  public trace: LoggerEvent
  public debug: LoggerEvent
  public info: LoggerEvent
  public warn: LoggerEvent
  public error: LoggerEvent

  constructor(trace: Trace) {
    const logfn = (level: Level, fields?: Record<string, any>) => {
      const self = this
      return function log(a: any, ...subs: any[]): any {
        // Handle template literals
        if (Array.isArray(a) && Array.isArray((a as any).raw)) {
          const message = String.raw(a as any, ...subs)
          return trace.event(undefined, level, message, { ...self.meta, ...fields })
        }

        // Handle string
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean' || a === null)
          return trace.event(undefined, level, a.toString(), { ...self.meta, ...fields })

        // Handle error
        if (a instanceof Error) {
          const f = { ...self.meta, ...fields, stack: a.stack, name: a.name, cause: a.cause }
          return trace.event(a.name, level, a.message, f)
        }

        // Handle object
        if (typeof a === 'object' && !Array.isArray(a) && a !== null) return logfn(level, { ...fields, ...a })

        // Handle everything else
        return trace.event(undefined, level, JSON.stringify(a), { ...self.meta, ...fields })
      }
    }

    this.trace = logfn(Level.TRACE)
    this.debug = logfn(Level.DEBUG)
    this.info = logfn(Level.INFO)
    this.warn = logfn(Level.WARN)
    this.error = logfn(Level.ERROR)

    const spanFn = (level: Level) => {
      const self = this
      return function span(
        name: string,
        fields?: Fields | undefined | null | (() => void | Promise<void>),
        fn2?: () => void | Promise<void>,
      ) {
        const fn1 = typeof fields === 'function'
        const sp = trace.span(name, level, fn1 ? self.meta : { ...self.meta, ...fields })
        if (!fn1 && typeof fn2 === 'undefined') return { exit: () => trace.exit(sp) }
        try {
          const r = fn1 ? fields() : fn2!()
          if (r instanceof Promise) {
            return r.finally(() => trace.exit(sp))
          }
          trace.exit(sp)
          return r
        } catch (err) {
          trace.exit(sp)
          throw err
        }
      }
    }

    this.span = Object.assign(spanFn(Level.TRACE), {
      trace: spanFn(Level.TRACE),
      debug: spanFn(Level.DEBUG),
      info: spanFn(Level.INFO),
      warn: spanFn(Level.WARN),
      error: spanFn(Level.ERROR),
    }) as Logger['span']
  }
}

export const getTarget = (): string | undefined => {
  const e = new Error()
  const lines = e.stack?.split('\n')
  const last = lines?.slice(1)?.findLastIndex((x) => /\@lickle[\/+]trace/.test(x))
  if (!last || last < 0) return undefined
  return lines?.[last + 1]?.replace(/^\s{0,}at\s?/, '').trim()
}

const defaultLogger: Logger = new Logger(defaultTrace)

export const span = defaultLogger.span
export const trace = defaultLogger.trace
export const debug = defaultLogger.debug
export const info = defaultLogger.info
export const warn = defaultLogger.warn
export const error = defaultLogger.error

export default defaultLogger
