import { uuid, now } from './util.js'

/**
 * Log levels in ascending order of severity.
 * @example
 * if (level >= Level.INFO) {
 *   // Handle important logs
 * }
 */
export enum Level {
  TRACE = 10,
  DEBUG = 20,
  INFO = 30,
  WARN = 40,
  ERROR = 50,
}

/** Type for structured logging fields */
export type Fields = Record<string, unknown>

/**
 * Metadata for spans and events.
 * @example
 * const meta: Metadata = {
 *   level: Level.INFO,
 *   name: 'process-request',
 *   ts: Date.now(),
 *   fields: { requestId: '123' }
 * };
 */
export interface Metadata {
  level: Level
  name?: string | undefined
  ts: number // timestamp
  parent?: string | undefined // parent span
  fields?: Fields | undefined
}

/**
 * Represents a span in the trace.
 * @example
 * const span: Span = {
 *   id: 'span-123',
 *   meta: { level: Level.INFO, name: 'operation' }
 * };
 */
export interface Span {
  type: 'span'
  id: string
  meta: Metadata
}

/**
 * Represents a log event in the trace.
 * @example
 * const event: Event = {
 *   meta: { level: Level.INFO, name: 'user-login' },
 *   message: 'User logged in successfully'
 * };
 */
export interface Event {
  id: string
  type: 'event'
  meta: Metadata
  message?: string | undefined
}

/**
 * Interface for subscribing to trace events.
 * @example
 * const subscriber: Subscriber = {
 *   onEvent: (evt) => console.log(evt.message),
 *   minLevel: Level.INFO
 * };
 */
export interface Subscriber<S extends Partial<Span> = Partial<Span>> {
  newSpan?: (meta: Metadata) => Span & S
  onEnter?: (span: Span & S) => void
  onExit?: (span: Span & S) => void
  onEvent?: (evt: Event) => void
  minLevel?: Level // filter threshold
}

/**
 * Main tracing class for managing spans and events.
 * @example
 * const trace = new Trace({
 *   onEvent: (evt) => console.log(evt.message),
 *   minLevel: Level.INFO
 * });
 * trace.span('operation', Level.INFO, { id: '123' });
 */
export class Trace {
  private stack: Span[] = []
  constructor(private sub: Subscriber = {}) {}

  /** Gets the current subscriber. */
  getSubscriber(): Subscriber {
    return this.sub
  }

  /** Sets a new subscriber. */
  setSubscriber(s: Subscriber) {
    this.sub = s
  }

  /**
   * Creates a new span with the given name, level, and optional fields.
   * @example
   * const span = trace.span('process-request', Level.INFO, { requestId: '123' });
   */
  span = (name: string, level = Level.INFO, fields?: Fields): Span => {
    if (!this.shouldEmit(level)) return { type: 'span' as const, id: '', meta: { name, level, ts: 0 } } // no-op span
    const meta = this.getMeta(name, level, fields)
    const sp = { type: 'span' as const, id: uuid(), meta, ...(this.sub.newSpan ? this.sub.newSpan(meta) : {}) }
    this.sub.onEnter?.(sp)
    this.stack.push(sp)
    return sp
  }

  /**
   * Enters an existing span, pushing it onto the stack.
   * @example
   * trace.enter(span);
   */
  enter = (sp: Span) => {
    if (!this.shouldEmit(sp.meta.level)) return
    this.sub.onEnter?.(sp)
    this.stack.push(sp)
  }

  /**
   * Exits a span, removing it from the stack if it's the top span.
   * @example
   * trace.exit(span);
   */
  exit = (sp: Span) => {
    if (!this.shouldEmit(sp.meta.level)) return
    this.sub.onExit?.(sp)
    if (this.stack[this.stack.length - 1]?.id === sp.id) this.stack.pop() // pop only if it's the top
  }

  /**
   * Creates a new event with the given name, level, message, and optional fields.
   * @example
   * trace.event('user-login', Level.INFO, 'User logged in', { userId: '123' });
   */
  event = (name: string | undefined, level: Level, msg?: string, fields?: Fields) => {
    if (!this.shouldEmit(level)) return
    const evt: Event = { id: uuid(), type: 'event', meta: this.getMeta(name, level, fields), message: msg }
    this.sub.onEvent?.(evt)
  }

  private getMeta = (name: string | undefined, level: Level, fields?: Fields) => {
    const p = this.stack[this.stack.length - 1]
    return { name, level, ts: now(), parent: p?.id, fields: fields ? { ...fields } : undefined }
  }

  private shouldEmit = (lvl?: Level) =>
    lvl &&
    lvl >= (this.sub.minLevel ?? Level.TRACE) &&
    (this.sub.newSpan || this.sub.onEnter || this.sub.onExit || this.sub.onEvent)
}

/**
 * Default global trace instance.
 * @example
 * defaultTrace.event('startup', Level.INFO, 'Application started');
 */
export const defaultTrace: Trace = new Trace()

export const span = defaultTrace.span
export const enter = defaultTrace.enter
export const exit = defaultTrace.exit
export const event = defaultTrace.event

/**
 * Sets a new subscriber for the default trace.
 * @example
 * setSubscriber({
 *   onEvent: (evt) => console.log(evt.message),
 *   minLevel: Level.INFO
 * });
 */
export const setSubscriber = (s: Subscriber): void => defaultTrace.setSubscriber(s)

/**
 * Gets the current subscriber from the default trace.
 * @example
 * const currentSub = getSubscriber();
 */
export const getSubscriber = (): Subscriber => defaultTrace.getSubscriber()
