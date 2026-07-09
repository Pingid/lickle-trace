/**
 * Log levels in ascending order of verbosity.
 */
export enum Level {
  TRACE = 10,
  DEBUG = 20,
  INFO = 30,
  WARN = 40,
  ERROR = 50,
}

/** Structured logging fields. */
export type Fields = Record<string, unknown>

/** A base type for both spans and events. */
export interface Base {
  /** The unique identifier defaults to a random hex UUID. */
  id: string
  /** The level of the event. */
  level: Level
  /** The timestamp in wall-clock milliseconds (sub-ms precise by default). */
  timestamp: number
  /** Arbitrary key-value pairs. */
  fields?: Fields | undefined
  /** The parent span id. */
  parentId?: string | undefined
}

/** Base serializable log event. */
export interface EventBase extends Base {
  /** Type discriminator. */
  type: 'event'
  /** The message of the event. */
  message?: string | undefined
}

/**
 * An event.
 *
 * `parent` is a best-effort reference captured when the event was created:
 * for local events it is the span active at emit time; for events ingested
 * via {@link RawTrace} it is resolved against the foreign spans currently
 * in flight. It is `undefined` when the parent has already exited or was
 * never seen — `parentId` remains authoritative for post-hoc linking.
 */
export interface Event<S = unknown> extends EventBase {
  /** The parent span, if it was in flight when the event was created. */
  parent?: Span<S> | undefined
}

/** Base serializable span. */
export interface SpanBase<S = unknown> extends Base {
  /** Type discriminator. */
  type: 'span'
  /** The name of the span. */
  name: string
  /** Layer-attached extension state. */
  ext?: S | undefined
}

/** A span. */
export interface Span<S = unknown> extends SpanBase<S> {
  /**
   * The parent span, captured by reference at creation. Best-effort in the
   * same sense as {@link Event.parent}; `parentId` is the durable link.
   */
  parent?: Span<S> | undefined
  /** Set fields after creation, like `tracing`'s `span.record`. */
  setFields(fields: Fields): void
  /** Enter this span, run `fn`, and guarantee exit (even on throw). */
  in<T>(fn: (span: Span<S>) => T): T
  /** Create a child span parented to this one, regardless of the active stack. */
  child(name: string, level?: Level, fields?: Fields): Span<S>
  /** Explicitly end the span (idempotent). Prefer `using` or `.in`. */
  end(): void
  /** `using span = ...` auto-ends at scope exit. */
  [Symbol.dispose](): void
}

/** The injectable pieces a Trace runs on. All have universal defaults. */
export interface TraceContext {
  /** Tracks which span is "current" for the calling logical task. */
  spans: Registry
  /** Receives span lifecycle callbacks and events. */
  layer: Layer
  /** Clock in wall-clock milliseconds (sub-ms precise by default). */
  now: () => number
  /** Id generator for trace, span, and event ids. */
  uid: () => string
}

export interface Trace {
  context: TraceContext
  span(name: string, level?: Level, fields?: Fields): Span
  event(message: string, level?: Level, fields?: Fields): void
  enter(span: Span): void
  exit(span: Span): void
  scope<T>(name: string, fn: (span: Span) => T, level?: Level, fields?: Fields): T
  current(): Span | undefined
  install(layer: Layer): void

  raw: RawTrace
}

/**
 * Ingestion boundary for spans and events originating in another context
 * (another Trace instance, another runtime, the Rust `tracing` bridge).
 *
 * The boundary owns the index of foreign spans currently in flight: a span
 * entered here is hydrated once, made current, and remembered until its
 * `exit` arrives, so events referencing it can resolve `parent`. The index
 * holds only in-flight spans — an exit removes the entry, and events whose
 * parent already exited resolve `parent: undefined` while keeping `parentId`.
 */
export interface RawTrace {
  event(ev: EventBase): void
  enter(span: SpanBase): void
  exit(span: SpanBase): void
}

/**
 * A layer receives span lifecycle callbacks and events.
 *
 * `newSpan` may return extension state stored on `span.ext`; it does not
 * control identity (the core owns trace/span ids). Combine layers with
 * `compose` from `@lickle/trace/layer`.
 */
export interface Layer<S = unknown> {
  /** Spans and events below this level are skipped entirely. Default: everything. */
  minLevel?: Level
  newSpan?: (span: Span<S>, trace: Trace) => S | void
  onEnter?: (span: Span<S>, trace: Trace) => void
  onExit?: (span: Span<S>, trace: Trace) => void
  onEvent?: (evt: Event, trace: Trace) => void
}

/**
 * Strategy for tracking which span is "current" for the calling logical task.
 *
 * Injected into a {@link Trace} so the core never depends on a runtime-specific
 * mechanism. The default `stackRegistry` is a shared LIFO stack; on Node,
 * `alsRegistry` scopes the chain per async task.
 *
 * Deliberately not an id index: an id -> span lookup either retains spans
 * globally (a leak) or answers unreliably across async contexts. Parent
 * references are captured where they are known instead — at event creation
 * for local events, and at the {@link RawTrace} boundary for foreign ones.
 */
export interface Registry {
  /** The span active for the calling logical task, if any. */
  current(): Span | undefined
  /** Push `span` as current (low-level; pair with `remove`). */
  push(span: Span): void
  /** Remove `span` wherever it sits. Idempotent. Returns true if it was present. */
  remove(span: Span): boolean
  /**
   * Establish a fresh nested scope inheriting the current active-span chain,
   * run `fn` within it, then discard the scope. Under an async-aware registry
   * (ALS) any spans opened inside `fn` are confined to the scope and cannot
   * accumulate globally, even if never explicitly ended.
   */
  run<T>(fn: () => T): T
}
