import { Utils, source } from './util/index.js'

/** Log levels in ascending order of severity. */
export const Levels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
} as const

/** Log level */
export type Level = keyof typeof Levels

/** Type for structured logging fields */
export type Fields = Record<string, unknown>

/** Metadata for spans and events. */
export interface Metadata {
  /** severity level */
  level: Level
  /** optional callsite name */
  name?: string
  /** target/module namespace */
  target?: string
  /** source file path */
  file?: string
  /** source line number */
  line?: number
  /** timestamp when created */
  ts: number
  /** parent span id */
  parent?: string
  /** structured fields */
  fields?: Fields
}

/** Represents a span in the trace. */
export interface Span {
  /** kind discriminator */
  type: 'span'
  /** span id */
  id: string
  /** span metadata */
  meta: Metadata
  /** per-span extensions bag */
  extensions?: Map<string, unknown>
}

/** Represents a log event in the trace. */
export interface Event {
  /** event id */
  id: string
  /** kind discriminator */
  type: 'event'
  /** event metadata */
  meta: Metadata
  /** optional message */
  message?: string | undefined
}

export interface Context {
  /** find a span by id */
  lookupSpan(id: string): Span | undefined
  /** current span if any */
  currentSpan(): Span | undefined
}

/**
 * Interface for subscribing to trace events.
 * @example
 * const subscriber: Subscriber = {
 *   onEvent: (evt) => console.log(evt.message),
 *   minLevel: Level.INFO
 * };
 */
export interface Layer<S extends Partial<Span> = Partial<Span>> {
  /** build per-layer span data for a new span */
  newSpan?: ((meta: Metadata, cx: Context) => Span & S) | undefined
  /** called when a span is entered */
  onEnter?: ((span: Span & S, cx: Context) => void) | undefined
  /** called when a span is exited */
  onExit?: ((span: Span & S, cx: Context) => void) | undefined
  /** called when a span is closed (end-of-life) */
  onClose?: ((span: Span & S, cx: Context) => void) | undefined
  /** handle an event */
  onEvent?: ((evt: Event, cx: Context) => void) | undefined
  /** minimum level this layer will receive */
  minLevel?: Level | undefined
  /** called when fields are recorded on a span */
  onRecord?: ((span: Span & S, cx: Context, fields: Fields) => void) | undefined
}

/**
 * Tracing runtime that manages spans and events.
 * @example
 * const t = new Trace();
 * const sp = t.span('operation', 'info', { id: '123' });
 * t.event('user-login', 'info', 'ok'); t.exit(sp); t.close(sp);
 */
export class Trace {
  private stack: Span[] = []
  private open: Map<string, Span> = new Map()
  private cx: Context = {
    currentSpan: () => Utils.ALS?.getStore?.() ?? this.stack[this.stack.length - 1],
    lookupSpan: (id: string) => this.open.get(id),
  }

  constructor(private sub: Layer = {}) {}

  /** Gets the current subscriber. */
  getSubscriber(): Layer {
    return this.sub
  }

  /** Sets a new subscriber. */
  setSubscriber(s: Layer) {
    this.sub = s
  }

  /** Create a new span and enter it. */
  span = (name: string, level: Level = 'info', fields?: Fields): Span => {
    if (!this.shouldEmit(level)) return { type: 'span' as const, id: '', meta: { name, level, ts: 0 } }
    const meta = this.getMeta(name, level, fields)
    const base: Span = { type: 'span', id: Utils.uuid(), meta, extensions: new Map() }
    const sp: Span = this.sub.newSpan ? { ...base, ...this.sub.newSpan(meta, this.cx) } : base
    this.open.set(sp.id, sp)
    this.sub.onEnter?.(sp, this.cx)
    this.stack.push(sp)
    Utils.ALS?.enterWith?.(sp)
    return sp
  }

  /** Enter an existing span. */
  enter = (sp: Span) => {
    if (!this.shouldEmit(sp.meta.level)) return
    this.sub.onEnter?.(sp, this.cx)
    this.stack.push(sp)
    Utils.ALS?.enterWith?.(sp)
  }

  /** Exit a span (does not close). */
  exit = (sp: Span) => {
    if (!this.shouldEmit(sp.meta.level)) return
    this.sub.onExit?.(sp, this.cx)
    if (this.stack[this.stack.length - 1]?.id === sp.id) this.stack.pop()
  }

  close = (sp: Span) => {
    if (!this.shouldEmit(sp.meta.level)) return
    this.sub.onClose?.(sp, this.cx)
    this.open.delete(sp.id)
  }

  /** Merge new fields into an existing span's metadata. */
  record = (sp: Span, fields: Fields) => {
    if (!this.shouldEmit(sp.meta.level)) return
    sp.meta.fields = { ...(sp.meta.fields ?? {}), ...fields }
    this.sub.onRecord?.(sp, this.cx, fields)
  }

  /** Emit an event. */
  event = (name: string | undefined, level: Level, msg?: string, fields?: Fields) => {
    if (!this.shouldEmit(level)) return
    const evt: Event = { id: Utils.uuid(), type: 'event', meta: this.getMeta(name, level, fields), message: msg }
    this.sub.onEvent?.(evt, this.cx)
  }

  private getMeta = (name: string | undefined, level: Level, fields?: Fields): Metadata => {
    const p = this.stack[this.stack.length - 1]
    const ts = Utils.now()
    const src = source()
    const overrideTarget = (fields?.['target'] as string | undefined) ?? undefined
    const target = overrideTarget ?? src.target
    const { file, line } = src
    const meta: Metadata = {
      level,
      ts,
      ...(name !== undefined ? { name } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(p?.id ? { parent: p.id } : {}),
      ...(fields
        ? {
            fields: (() => {
              const { target: _t, ...rest } = fields as any
              return rest as Fields
            })(),
          }
        : {}),
    }
    return meta
  }

  private shouldEmit = (lvl?: Level) =>
    lvl &&
    Levels[lvl] >= Levels[this.sub.minLevel ?? 'trace'] &&
    (this.sub.newSpan || this.sub.onEnter || this.sub.onExit || this.sub.onClose || this.sub.onEvent)
}

/**
 * Default global trace instance.
 * @example
 * import { span, exit, close, event } from 'lickle-trace'
 * const sp = span('work', 'info'); event('working', 'debug'); exit(sp); close(sp)
 */
export const defaultTrace: Trace = new Trace()

export const span = defaultTrace.span
export const enter = defaultTrace.enter
export const exit = defaultTrace.exit
export const close = defaultTrace.close
export const event = defaultTrace.event

export const log = {
  trace: (message?: string, fields?: Fields) => defaultTrace.event(undefined, 'trace', message, fields),
  debug: (message?: string, fields?: Fields) => defaultTrace.event(undefined, 'debug', message, fields),
  info: (message?: string, fields?: Fields) => defaultTrace.event(undefined, 'info', message, fields),
  warn: (message?: string, fields?: Fields) => defaultTrace.event(undefined, 'warn', message, fields),
  error: (message?: string, fields?: Fields) => defaultTrace.event(undefined, 'error', message, fields),
}

/** Set the global subscriber. */
export const setSubscriber = (s: Layer): void => defaultTrace.setSubscriber(s)

/** Get the current global subscriber. */
export const getSubscriber = (): Layer => defaultTrace.getSubscriber()

/**
 * Decorator that instruments a method with a span around its execution.
 * @example
 * class Svc { @instrument('svc.do', 'info') do(id: string) { /* ... *\/ } }
 */
export function instrument(name?: string, level: Level = 'trace', target?: string) {
  return (_t: any, _k: string, desc: PropertyDescriptor) => {
    const fn = desc.value
    desc.value = function (...args: any[]) {
      const sp = defaultTrace.span(name ?? fn.name, level, { args, ...(target ? { target } : {}) })
      try {
        return fn.apply(this, args)
      } finally {
        defaultTrace.exit(sp)
        defaultTrace.close(sp)
      }
    }
    return desc
  }
}
