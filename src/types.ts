/**
 * Severity levels, ordered least to most severe.
 *
 * A plain const object rather than a TypeScript `enum`: enums are not
 * erasable syntax, so they break type-stripping runtimes (`node
 * --experimental-strip-types`, and this package ships raw `src` to both
 * npm and JSR). The values are strings so they are self-describing on the
 * wire — and they match the `console` method names exactly, which the
 * console layer relies on.
 */
export const Level = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const

/** One of the {@link Level} values. */
export type Level = (typeof Level)[keyof typeof Level]

/**
 * Numeric rank per level; higher is more severe. Level comparison goes
 * through this map, since the string values have no useful ordering.
 */
export const severity: Readonly<Record<Level, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
}

/** Structured logging fields. */
export type Fields = Record<string, unknown>

/** A base type for both spans and events. */
export interface Base {
  /** The unique identifier, defaults to a random hex UUID. */
  id: string
  /**
   * The id of the root of this trace, inherited by every descendant.
   *
   * Minted when a span or event has no parent, then carried down unchanged.
   * This is what makes a trace addressable as a whole — correlation across a
   * service boundary, OTLP export, and consistent head sampling all read it
   * rather than walking `parentId` (which cannot be walked at all for spans
   * arriving through `@lickle/trace/ingest`).
   */
  traceId: string
  /** The level of the span or event. */
  level: Level
  /** The timestamp in wall-clock milliseconds (sub-ms precise by default). */
  timestamp: number
  /**
   * Where this came from — conventionally a `:`-separated module path such
   * as `app:db:pool`. Optional and unused by the core; `envFilter` from
   * `@lickle/trace/layer` matches directives against it.
   */
  target?: string | undefined
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
 * through `@lickle/trace/ingest` it is resolved against the foreign spans
 * currently in flight. It is `undefined` when the parent has already exited
 * or was never seen — `parentId` remains authoritative for post-hoc linking.
 */
export interface Event extends EventBase {
  /** The parent span, if it was in flight when the event was created. */
  parent?: Span | undefined
  /** The serializable shape, without the live `parent` reference. */
  toJSON(): EventBase
}

/** Base serializable span. */
export interface SpanBase extends Base {
  /** Type discriminator. */
  type: 'span'
  /** The name of the span. */
  name: string
  /**
   * When the span ended, in the same clock as {@link Base.timestamp}; set by
   * the core on exit, so every layer reads one agreed duration instead of
   * calling the clock itself.
   */
  endTimestamp?: number | undefined
}

/** A span. */
export interface Span extends SpanBase {
  /**
   * The parent span, captured by reference at creation. Best-effort in the
   * same sense as {@link Event.parent}; `parentId` is the durable link.
   */
  parent?: Span | undefined
  /** Set fields after creation, like `tracing`'s `span.record`. */
  setFields(fields: Fields): void
  /** Enter this span, run `fn`, and guarantee exit (even on throw). */
  in<T>(fn: (span: Span) => T): T
  /** Create a child span parented to this one, regardless of the active stack. */
  child(name: string, level?: Level, fields?: Fields, target?: string): Span
  /** Explicitly end the span (idempotent). Prefer `using` or `.in`. */
  end(): void
  /** `using span = ...` auto-ends at scope exit. */
  [Symbol.dispose](): void
  /** The serializable shape, without the live `parent` reference. */
  toJSON(): SpanBase
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
  span(name: string, level?: Level, fields?: Fields, target?: string): Span
  event(message: string, level?: Level, fields?: Fields, target?: string): void
  scope<T>(name: string, fn: (span: Span) => T, level?: Level, fields?: Fields, target?: string): T
  current(): Span | undefined
  install(layer: Layer): void
  /** Ask the installed layer to drain anything it has buffered. */
  flush(): Promise<void>
}

/**
 * A layer receives span lifecycle callbacks and events.
 *
 * Layers own their own per-span state: key a `WeakMap` by the span, which is
 * isolated by construction and collected with the span. Combine layers with
 * `compose` from `@lickle/trace/layer`.
 */
export interface Layer {
  /** Spans and events below this level are skipped entirely. Default: everything. */
  minLevel?: Level
  onEnter?: (span: Span, trace: Trace) => void
  onExit?: (span: Span, trace: Trace) => void
  onEvent?: (evt: Event, trace: Trace) => void
  /**
   * Drain any buffered work. Called by {@link Trace.flush} — an exporter that
   * batches must implement this or it will lose data at process exit.
   */
  flush?: () => void | Promise<void>
}

/**
 * Strategy for tracking which span is "current" for the calling logical task.
 *
 * Injected into a {@link Trace} so the core never depends on a runtime-specific
 * mechanism. `stackRegistry` is a shared LIFO stack; `alsRegistry` scopes the
 * chain per async task and is selected automatically where `node:async_hooks`
 * is reachable.
 *
 * Deliberately not an id index: an id -> span lookup either retains spans
 * globally (a leak) or answers unreliably across async contexts. Parent
 * references are captured where they are known instead — at event creation
 * for local events, and at the ingestion boundary for foreign ones.
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
