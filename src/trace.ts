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
} from './types.ts'
import { registry } from './registry.ts'
import { enabled, errorFields, now, uid } from './util.ts'

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

  constructor(options?: Partial<TraceContext>) {
    this.context = {
      spans: registry(),
      layer: {},
      now: now,
      uid: uid,
      ...options,
    }
  }

  /** Replace the layer receiving this trace's spans and events. */
  install = (layer: Layer): void => {
    this.context.layer = layer
  }

  /** The span currently active in this trace's context, if any. */
  current = (): Span | undefined => this.context.spans.current()

  /** Ask the installed layer to drain anything it has buffered. */
  flush = (): Promise<void> => Promise.resolve(this.context.layer.flush?.()).then(() => undefined)

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
  span = (name: string, level: Level = Level.INFO, fields?: Fields, target?: string): Span => {
    const parent = this.current()
    if (!enabled(level, this.context.layer)) return SpanImpl.noop(this, name, level, parent, target)
    return SpanImpl.start(this, name, level, parent, fields, target)
  }

  /** Emit an event, attributed to the active span if one exists. */
  event = (message: string, level: Level = Level.INFO, fields: Fields = {}, target?: string): void => {
    if (!enabled(level, this.context.layer)) return
    this.context.layer.onEvent?.(EventImpl.emit(this, level, message, fields, target), this)
  }

  /**
   * Run `fn` inside a fresh span, ending it when `fn` returns (or, if `fn`
   * returns a promise, when it settles). A throw or rejection is recorded on
   * the span as an `error` field before it exits, then rethrown untouched.
   *
   * Under an async-aware registry the span chain is confined to the scope, so
   * concurrent scopes can't see or corrupt each other's parenting.
   */
  scope = <T>(name: string, fn: (sp: Span) => T, level: Level = Level.INFO, fields?: Fields, target?: string): T => {
    const parent = this.current()

    if (!enabled(level, this.context.layer)) {
      return fn(SpanImpl.noop(this, name, level, parent, target))
    }

    return this.context.spans.run(() => {
      const sp = SpanImpl.start(this, name, level, parent, fields, target)

      try {
        const result: unknown = fn(sp)

        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(
            (value) => {
              sp.end()
              return value
            },
            (err: unknown) => {
              sp.setFields(errorFields(err))
              sp.end()
              throw err
            },
          ) as T
        }

        sp.end()
        return result as T
      } catch (err) {
        sp.setFields(errorFields(err))
        sp.end()
        throw err
      }
    })
  }

  /**
   * Internal exit path, deliberately absent from the public {@link Trace}
   * surface — `span.end()`, `span.in()` and `scope()` are the ways in.
   *
   * Idempotent: a second call is a no-op. Robust to out-of-order exits —
   * removes the span wherever it sits in the context rather than only popping
   * the top, so async interleaving can't leak.
   */
  exit(sp: Span): void {
    if (sp.id === '') return // no-op span
    const marked = sp as Span & { [kEnded]?: boolean }
    if (marked[kEnded]) return // already ended
    marked[kEnded] = true
    sp.endTimestamp = this.context.now()
    this.context.spans.remove(sp)
    this.context.layer.onExit?.(sp, this)
  }
}

class SpanImpl implements Span {
  readonly type = 'span' as const
  id: string
  traceId: string
  timestamp: number
  endTimestamp?: number | undefined
  target?: string | undefined
  fields?: Fields | undefined
  parentId?: string | undefined
  parent?: Span | undefined

  /**
   * Pure assignment only — no hook firing, no registry push. Lifecycle entry
   * happens in {@link SpanImpl.start} (local spans) or in {@link adoptSpan}
   * (foreign spans), so hydration can never double-fire `onEnter`.
   */
  private constructor(
    private trace: TraceImpl,
    public name: string,
    public level: Level,
    parent: Span | undefined,
    parentId: string | undefined,
    id: string,
    traceId: string,
    timestamp: number,
    fields?: Fields,
    target?: string,
  ) {
    this.id = id
    this.traceId = traceId
    this.timestamp = timestamp
    this.parent = parent
    this.parentId = parentId
    this.target = target
    this.fields = fields ? { ...fields } : undefined
  }

  /** Create a live local span: assigns identity, makes it current, fires `onEnter`. */
  static start(
    trace: TraceImpl,
    name: string,
    level: Level,
    parent: Span | undefined,
    fields?: Fields,
    target?: string,
  ): SpanImpl {
    const { uid, now, layer, spans } = trace.context
    // A root span mints the trace id; every descendant inherits it unchanged.
    const span = new SpanImpl(
      trace,
      name,
      level,
      parent,
      parent?.id,
      uid(),
      parent?.traceId || uid(),
      now(),
      fields,
      target,
    )
    // Make the span current before notifying, so anything a layer emits from
    // `onEnter` is attributed to this span rather than its parent.
    spans.push(span)
    layer.onEnter?.(span, trace)
    return span
  }

  /** Rebuild a span from its wire shape without firing any lifecycle hooks. */
  static hydrate(trace: TraceImpl, sb: SpanBase, parent?: Span): SpanImpl {
    const span = new SpanImpl(
      trace,
      sb.name,
      sb.level,
      parent,
      sb.parentId,
      sb.id,
      sb.traceId || parent?.traceId || trace.context.uid(),
      sb.timestamp,
      sb.fields,
      sb.target,
    )
    span.endTimestamp = sb.endTimestamp
    return span
  }

  /** An inert span for filtered-out levels; safe to enter/child/end/pass around. */
  static noop(trace: TraceImpl, name: string, level: Level, parent: Span | undefined, target?: string): SpanImpl {
    // A filtered-out span is invisible, so its children parent to the same
    // span it would have — hence parent/parentId still point at the real parent.
    return new SpanImpl(trace, name, level, parent, parent?.id, '', parent?.traceId ?? '', 0, undefined, target)
  }

  private get isNoop(): boolean {
    return this.id === ''
  }

  setFields(fields: Fields): void {
    if (this.isNoop) return
    this.fields = { ...this.fields, ...fields }
  }

  child(name: string, level?: Level, fields?: Fields, target?: string): Span {
    const lvl = level ?? this.level
    const tgt = target ?? this.target
    if (!enabled(lvl, this.trace.context.layer))
      return SpanImpl.noop(this.trace, name, lvl, this.isNoop ? this.parent : this, tgt)
    if (this.isNoop) return SpanImpl.start(this.trace, name, lvl, this.parent, fields, tgt)
    return SpanImpl.start(this.trace, name, lvl, this, fields, tgt)
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
      traceId: this.traceId,
      type: 'span',
      name: this.name,
      level: this.level,
      timestamp: this.timestamp,
      endTimestamp: this.endTimestamp,
      target: this.target,
      parentId: this.parentId,
      fields: this.fields,
    }
  }
}

class EventImpl implements Event {
  readonly type = 'event' as const
  id: string
  traceId: string
  timestamp: number
  target?: string | undefined
  parentId?: string | undefined
  /** Best-effort reference captured at creation; `parentId` is the durable link. */
  parent?: Span | undefined

  private constructor(
    public level: Level,
    id: string,
    traceId: string,
    timestamp: number,
    parent: Span | undefined,
    parentId: string | undefined,
    public message?: string | undefined,
    public fields?: Fields | undefined,
    target?: string,
  ) {
    this.id = id
    this.traceId = traceId
    this.timestamp = timestamp
    this.parent = parent
    this.parentId = parentId
    this.target = target
  }

  /** Create a local event, capturing the currently-active span by reference. */
  static emit(trace: TraceImpl, level: Level, message: string, fields?: Fields, target?: string): EventImpl {
    const parent = trace.current()
    const { uid, now } = trace.context
    return new EventImpl(level, uid(), parent?.traceId || uid(), now(), parent, parent?.id, message, fields, target)
  }

  /** Rebuild an event from its wire shape; `parent` resolved by the caller. */
  static hydrate(trace: TraceImpl, eb: EventBase, parent?: Span): EventImpl {
    return new EventImpl(
      eb.level,
      eb.id,
      eb.traceId || parent?.traceId || trace.context.uid(),
      eb.timestamp,
      parent,
      eb.parentId,
      eb.message,
      eb.fields,
      eb.target,
    )
  }

  toJSON(): EventBase {
    return {
      id: this.id,
      traceId: this.traceId,
      type: 'event',
      level: this.level,
      timestamp: this.timestamp,
      target: this.target,
      parentId: this.parentId,
      fields: this.fields,
      message: this.message,
    }
  }
}

/**
 * Materialize a span that originated somewhere else — another Trace, another
 * runtime, an incoming `traceparent` — as a live span in `trace`: hydrated,
 * made current, and announced to the layer with `onEnter`.
 *
 * This is the one primitive the core owes the outside world; everything that
 * crosses a boundary (`@lickle/trace/ingest`, `@lickle/trace/propagate`) is
 * built on it plus `span.end()`. Returns `undefined` when the span's level is
 * filtered out.
 */
export const adoptSpan = (trace: Trace, span: SpanBase, parent?: Span): Span | undefined => {
  const t = trace as TraceImpl
  if (!enabled(span.level, t.context.layer)) return undefined
  const sp = SpanImpl.hydrate(t, span, parent)
  t.context.spans.push(sp)
  t.context.layer.onEnter?.(sp, t)
  return sp
}

/**
 * Make a span from another context current *without* announcing it.
 *
 * The difference from {@link adoptSpan} is who owns the record: a span arriving
 * through `@lickle/trace/ingest` is ours to report, while the remote parent
 * named by an incoming `traceparent` has already been reported by the caller —
 * announcing it again would double-count it at the collector. A linked span is
 * pure context: descendants inherit its `traceId` and parent onto its id.
 *
 * It is not level-filtered, since context is not a record. Remove it with
 * `trace.context.spans.remove(span)` — never `end()`, which announces.
 */
export const linkSpan = (trace: Trace, span: SpanBase, parent?: Span): Span => {
  const t = trace as TraceImpl
  const sp = SpanImpl.hydrate(t, span, parent)
  t.context.spans.push(sp)
  return sp
}

/**
 * Deliver an event that originated somewhere else, resolving `parent` from the
 * caller rather than from the active stack. See {@link adoptSpan}.
 */
export const adoptEvent = (trace: Trace, event: EventBase, parent?: Span): void => {
  const t = trace as TraceImpl
  if (!enabled(event.level, t.context.layer)) return
  t.context.layer.onEvent?.(EventImpl.hydrate(t, event, parent), t)
}

export const createTrace = (options?: Partial<TraceContext>): Trace => new TraceImpl(options)

/** The default global trace instance. */
const defaultTrace: Trace = createTrace()

/** The default global trace instance. */
export default defaultTrace
