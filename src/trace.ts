import {
  Level,
  type Fields,
  type Span,
  type SpanBase,
  type Event,
  type EventBase,
  type Trace,
  type TraceContext,
  type Layer,
  type RawTrace,
} from './types.ts'
import { registry } from '#registry'
import { enabled, now, uid } from './util.ts'

/** Marks a span as ended so `exit` is idempotent even if the registry misses. */
const kEnded = Symbol('lickle.ended')

/**
 * Manages spans and events for a single logical context.
 *
 * The active-span stack is only a convenience for *implicit* parenting of
 * synchronous code and top-level events. Correct parenting across `await`
 * comes from `span.child(...)` / `span.in(...)`, which never read the stack.
 */
class TraceImpl implements Trace {
  context: TraceContext
  raw: RawTrace

  constructor(options?: Partial<TraceContext>) {
    this.context = {
      spans: registry(),
      layer: {},
      now: now,
      uid: uid,
      ...options,
    }
    this.raw = new RawTraceImpl(this)
  }

  /** Replace the layer receiving this trace's spans and events. */
  install(layer: Layer): void {
    this.context.layer = layer
  }

  /** The span currently active in this trace's context, if any. */
  current(): Span | undefined {
    return this.context.spans.current()
  }

  /**
   * Create a span parented to the currently-active span (if any).
   * Returns a disposable, always-valid span — even when filtered out
   * (in which case it is an inert no-op that is safe to enter/exit/pass around).
   *
   * The span is made current immediately and stays current until `end()`.
   * Under an async-aware registry this entry happens in the *calling* context
   * with no scope boundary around it, so a span that is never ended can
   * remain current beyond its intended lifetime. When work has a natural
   * function boundary, prefer {@link scope}, which confines the span chain.
   */
  span = (name: string, level: Level = Level.INFO, fields?: Fields): Span => {
    const parent = this.current()
    if (!enabled(level, this.context.layer)) return SpanImpl.noop(this, name, level, parent)
    return SpanImpl.start(this, name, level, parent, fields)
  }

  /** Emit an event, attributed to the active span if one exists. */
  event = (message: string, level: Level = Level.INFO, fields: Fields = {}): void => {
    if (!enabled(level, this.context.layer)) return
    this.context.layer.onEvent?.(EventImpl.emit(this, level, message, fields), this)
  }

  /** Low-level enter: make `sp` current. Prefer `span.in`. */
  enter = (sp: Span): void => {
    if (sp.id === '') return // no-op span
    this.context.spans.push(sp)
  }

  /**
   * Low-level exit. Idempotent — a second call is a no-op. Robust to
   * out-of-order exits: removes the span wherever it sits in the context
   * rather than only popping the top, so async interleaving can't leak.
   */
  exit = (sp: Span): void => {
    if (sp.id === '') return
    const marked = sp as Span & { [kEnded]?: boolean }
    if (marked[kEnded]) return // already ended
    marked[kEnded] = true
    this.context.spans.remove(sp)
    this.context.layer.onExit?.(sp, this)
  }

  /**
   * Run `fn` inside a fresh span, ending it when `fn` returns (or, if `fn`
   * returns a promise, when it settles). Under an async-aware registry the
   * span chain is confined to the scope, so concurrent scopes can't see or
   * corrupt each other's parenting.
   */
  scope<T>(name: string, fn: (sp: Span) => T, level?: Level, fields?: Fields): T
  scope<T>(name: string, fn: (sp: Span) => Promise<T>, level?: Level, fields?: Fields): Promise<T>
  scope<T>(name: string, fn: (sp: Span) => T | Promise<T>, level: Level = Level.INFO, fields?: Fields): T | Promise<T> {
    const parent = this.current()

    if (!enabled(level, this.context.layer)) {
      return fn(SpanImpl.noop(this, name, level, parent))
    }

    return this.context.spans.run(() => {
      const sp = SpanImpl.start(this, name, level, parent, fields)

      try {
        const result: any = fn(sp)

        if (result && typeof (result as PromiseLike<T>).then === 'function') {
          return Promise.resolve(result).finally(() => sp.end())
        }

        sp.end()
        return result
      } catch (err) {
        sp.end()
        throw err
      }
    })
  }
}

/**
 * Ingestion boundary for spans and events from another context (another
 * Trace, another runtime, the Rust `tracing` bridge over wasm).
 *
 * Owns the index of foreign spans currently in flight: `enter` hydrates the
 * wire shape into a real {@link Span} exactly once (firing `newSpan`/`onEnter`
 * and making it current), `exit` retires it, and `event` resolves `parent`
 * against the in-flight index. The index holds only live foreign spans, so
 * it cannot accumulate past what the foreign side has open.
 */
class RawTraceImpl implements RawTrace {
  private active = new Map<string, Span>()

  constructor(private trace: TraceImpl) {}

  enter(sb: SpanBase): void {
    if (!enabled(sb.level, this.trace.context.layer)) return
    if (this.active.has(sb.id)) return // idempotent re-entry
    const parent = sb.parentId !== undefined ? this.active.get(sb.parentId) : undefined
    const sp = SpanImpl.hydrate(sb, this.trace, parent)
    this.active.set(sp.id, sp)

    const layer = this.trace.context.layer
    const ext = layer.newSpan?.(sp, this.trace)
    if (ext !== undefined) sp.ext = ext
    this.trace.context.spans.push(sp)
    layer.onEnter?.(sp, this.trace)
  }

  exit(sb: SpanBase): void {
    const sp = this.active.get(sb.id)
    if (!sp) return // unknown, filtered at enter, or already exited
    this.active.delete(sb.id)
    this.trace.exit(sp) // handles idempotence, registry removal, onExit
  }

  event(eb: EventBase): void {
    if (!enabled(eb.level, this.trace.context.layer)) return
    const parent = eb.parentId !== undefined ? this.active.get(eb.parentId) : undefined
    this.trace.context.layer.onEvent?.(EventImpl.hydrate(eb, parent), this.trace)
  }
}

class SpanImpl implements Span {
  readonly type = 'span' as const
  id: string
  timestamp: number
  fields?: Fields | undefined
  ext?: unknown
  parentId?: string | undefined
  parent?: Span | undefined

  /**
   * Pure assignment only — no hook firing, no registry push. Lifecycle entry
   * happens in {@link SpanImpl.start} (local spans) or at the {@link RawTrace}
   * boundary (foreign spans), so hydration can never double-fire `onEnter`.
   */
  private constructor(
    private trace: TraceImpl,
    public name: string,
    public level: Level,
    parent: Span | undefined,
    parentId: string | undefined,
    id: string,
    timestamp: number,
    fields?: Fields,
  ) {
    this.id = id
    this.timestamp = timestamp
    this.parent = parent
    this.parentId = parentId
    this.fields = fields ? { ...fields } : undefined
  }

  /** Create a live local span: assigns identity, fires `newSpan`/`onEnter`, makes it current. */
  static start(trace: TraceImpl, name: string, level: Level, parent: Span | undefined, fields?: Fields): SpanImpl {
    const { uid, now, layer, spans } = trace.context
    const span = new SpanImpl(trace, name, level, parent, parent?.id, uid(), now(), fields)
    const ext = layer.newSpan?.(span, trace)
    if (ext !== undefined) span.ext = ext
    // Make the span current before notifying, so anything a layer emits from
    // `onEnter` is attributed to this span rather than its parent.
    spans.push(span)
    layer.onEnter?.(span, trace)
    return span
  }

  /** Rebuild a span from its wire shape without firing any lifecycle hooks. */
  static hydrate(sb: SpanBase, trace: TraceImpl, parent?: Span): SpanImpl {
    const span = new SpanImpl(trace, sb.name, sb.level, parent, sb.parentId, sb.id, sb.timestamp, sb.fields)
    span.ext = sb.ext
    return span
  }

  /** An inert span for filtered-out levels; safe to enter/child/end/pass around. */
  static noop(trace: TraceImpl, name: string, level: Level, parent: Span | undefined): SpanImpl {
    // A filtered-out span is invisible, so its children parent to the same
    // span it would have — hence parent/parentId still point at the real parent.
    return new SpanImpl(trace, name, level, parent, parent?.id, '', 0)
  }

  private get isNoop(): boolean {
    return this.id === ''
  }

  setFields(fields: Fields): void {
    if (this.isNoop) return
    this.fields = { ...this.fields, ...fields }
  }

  child(name: string, level?: Level, fields?: Fields): Span {
    const lvl = level ?? this.level
    if (!enabled(lvl, this.trace.context.layer))
      return SpanImpl.noop(this.trace, name, lvl, this.isNoop ? this.parent : this)
    if (this.isNoop) return SpanImpl.start(this.trace, name, lvl, this.parent, fields)
    return SpanImpl.start(this.trace, name, lvl, this, fields)
  }

  in<T>(fn: (span: Span) => T): T {
    try {
      return fn(this)
    } finally {
      this.end()
    }
  }

  end(): void {
    if (!this.isNoop) this.trace.exit(this)
  }

  [Symbol.dispose](): void {
    this.end()
  }

  toJSON(): SpanBase {
    return {
      id: this.id,
      type: 'span',
      name: this.name,
      level: this.level,
      timestamp: this.timestamp,
      parentId: this.parentId,
      fields: this.fields,
      ext: this.ext,
    }
  }
}

class EventImpl implements Event {
  readonly type = 'event' as const
  id: string
  timestamp: number
  parentId?: string | undefined
  /** Best-effort reference captured at creation; `parentId` is the durable link. */
  parent?: Span | undefined

  private constructor(
    public level: Level,
    id: string,
    timestamp: number,
    parent: Span | undefined,
    parentId: string | undefined,
    public message?: string | undefined,
    public fields?: Fields | undefined,
  ) {
    this.id = id
    this.timestamp = timestamp
    this.parent = parent
    this.parentId = parentId
  }

  /** Create a local event, capturing the currently-active span by reference. */
  static emit(trace: TraceImpl, level: Level, message: string, fields?: Fields): EventImpl {
    const parent = trace.current()
    return new EventImpl(level, trace.context.uid(), trace.context.now(), parent, parent?.id, message, fields)
  }

  /** Rebuild an event from its wire shape; `parent` resolved by the caller (RawTrace). */
  static hydrate(eb: EventBase, parent?: Span): EventImpl {
    return new EventImpl(eb.level, eb.id, eb.timestamp, parent, eb.parentId, eb.message, eb.fields)
  }

  toJSON(): EventBase {
    return {
      id: this.id,
      type: 'event',
      level: this.level,
      timestamp: this.timestamp,
      parentId: this.parentId,
      fields: this.fields,
      message: this.message,
    }
  }
}

export const createTrace = (options?: Partial<TraceContext>): Trace => {
  return new TraceImpl(options)
}

/** The default global trace instance. */
const defaultTrace = createTrace()

/** The default global trace instance. */
export default defaultTrace

export type { Fields, Span, SpanBase, Event, EventBase, Trace, TraceContext, Layer, RawTrace }

export { Level }

export * from '#registry'
