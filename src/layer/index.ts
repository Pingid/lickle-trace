import { Level, severity, type Event, type EventBase, type Layer, type Span, type SpanBase } from '../types.ts'
import { enabled } from '../util.ts'

export * as Console from './console.ts'
export { print, type PrintFn } from './util.ts'

/** The least severe floor across `layers` — what the core must not pre-filter. */
const floor = (layers: Layer[]): Level => {
  let lowest: Level = Level.ERROR
  for (const l of layers) {
    const lvl = l.minLevel ?? Level.TRACE
    if (severity[lvl] < severity[lowest]) lowest = lvl
  }
  return lowest
}

/**
 * Combine several layers into one. Callbacks fan out in declaration order,
 * and each layer's own `minLevel` is still respected, so layers with
 * different floors can share one trace. `flush` awaits every layer.
 *
 * Layers keep their own per-span state in a `WeakMap` keyed by the span, so
 * composition needs no state-swapping machinery and nothing layer-private can
 * reach the serialized span.
 *
 * @example
 * ```ts
 * defaultTrace.install(compose(minLevel(Level.WARN, Console.layer()), otlpLayer))
 * ```
 */
export const compose = (...layers: Layer[]): Layer => {
  if (layers.length === 0) return {}
  if (layers.length === 1) return { ...layers[0]! }

  const each = (level: Level, fn: (layer: Layer) => void): void => {
    for (const l of layers) if (enabled(level, l)) fn(l)
  }

  return {
    minLevel: floor(layers),
    onEnter: (span, trace) => each(span.level, (l) => l.onEnter?.(span, trace)),
    onExit: (span, trace) => each(span.level, (l) => l.onExit?.(span, trace)),
    onEvent: (evt, trace) => each(evt.level, (l) => l.onEvent?.(evt, trace)),
    flush: async () => void (await Promise.all(layers.map((l) => l.flush?.()))),
  }
}

/**
 * Return a copy of `layer` gated to `level` and above.
 *
 * @example
 * ```ts
 * defaultTrace.install(minLevel(Level.INFO, Console.layer()))
 * ```
 */
export const minLevel = (level: Level, layer: Layer): Layer => ({ ...layer, minLevel: level })

/**
 * Wrap `layer` so it only sees spans and events accepted by `accept`.
 *
 * A span rejected at creation is hidden from the layer for its whole lifecycle
 * (no `onEnter`/`onExit`); events are tested one by one. Rejected spans are
 * held in a `WeakSet`, so membership cannot outlive the span itself.
 */
const gate = (accept: (item: Span | Event) => boolean, layer: Layer): Layer => {
  const hidden = new WeakSet<object>()
  return {
    minLevel: layer.minLevel,
    onEnter(span, trace) {
      if (!accept(span)) return void hidden.add(span)
      layer.onEnter?.(span, trace)
    },
    onExit(span, trace) {
      if (!hidden.has(span)) layer.onExit?.(span, trace)
    },
    onEvent(evt, trace) {
      if (accept(evt)) layer.onEvent?.(evt, trace)
    },
    ...(layer.flush ? { flush: () => layer.flush?.() } : {}),
  }
}

/**
 * Wrap `layer` so it only receives spans and events for which `pred` returns
 * true.
 *
 * @example
 * ```ts
 * defaultTrace.install(filter((item) => item.type !== 'span' || item.name !== 'noisy', Console.layer()))
 * ```
 */
export const filter = (pred: (item: Span | Event) => boolean, layer: Layer): Layer => gate(pred, layer)

/** One parsed `envFilter` directive. */
interface Directive {
  target: string
  level: Level | 'off'
}

const parseDirectives = (spec: string): Directive[] =>
  spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.lastIndexOf('=')
      const target = eq === -1 ? '' : part.slice(0, eq).trim()
      const name = (eq === -1 ? part : part.slice(eq + 1)).trim().toLowerCase()
      const level: Level | 'off' = name === 'off' ? 'off' : ((name in severity ? name : Level.TRACE) as Level)
      return { target, level }
    })
    // Longest target first, so the most specific directive wins.
    .sort((a, b) => b.target.length - a.target.length)

/** `app:db` is covered by `app` and by `app:db`, but not by `app:d`. */
const covers = (directive: string, target: string): boolean =>
  directive === '' || target === directive || target.startsWith(`${directive}:`)

/**
 * Gate `layer` with a `tracing`-style directive string matched against each
 * item's {@link Span.target}.
 *
 * A directive is `level` (the default floor) or `target=level`, where `level`
 * is a {@link Level} name or `off`. The longest matching target wins, and
 * matching is on `:`-separated segments, so `app` covers `app:db` but not
 * `apple`. Untargeted items are judged by the bare default directive only.
 *
 * @example
 * ```ts
 * defaultTrace.install(envFilter('info,app:db=debug,app:health=off', Console.layer()))
 * ```
 */
export const envFilter = (spec: string, layer: Layer): Layer => {
  const directives = parseDirectives(spec)
  const accept = (item: Span | Event): boolean => {
    const target = item.target ?? ''
    const match = directives.find((d) => covers(d.target, target))
    if (!match || match.level === 'off') return false
    return severity[item.level] >= severity[match.level]
  }
  // The lowest floor any directive allows — anything stricter can be applied
  // cheaply by the core before the item is ever built.
  const lowest = directives.reduce<Level>(
    (acc, d) => (d.level !== 'off' && severity[d.level] < severity[acc] ? d.level : acc),
    Level.ERROR,
  )
  return { ...gate(accept, layer), minLevel: lowest }
}

/** FNV-1a. Deterministic across processes — two services hash a trace id alike. */
const hash = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/**
 * Head-sample `layer` down to `rate` (0 to 1) of traces.
 *
 * The decision is derived from {@link Span.traceId} rather than stored, so it
 * is stateless, consistent for every span and event in a trace, and identical
 * in every service that sees the same trace id — a sampled trace stays whole
 * across a service boundary instead of arriving in fragments.
 *
 * @example
 * ```ts
 * defaultTrace.install(sample(0.01, otlpLayer))
 * ```
 */
export const sample = (rate: number, layer: Layer): Layer => {
  if (rate >= 1) return { ...layer }
  if (rate <= 0) return { minLevel: layer.minLevel }
  return gate((item) => hash(item.traceId) / 0xffffffff < rate, layer)
}

export interface BatchOptions {
  /** Flush once this many records are buffered. Default 512. */
  size?: number
  /** Flush at most this many ms after the first buffered record. Default 5000. */
  interval?: number
  /** Called if `send` rejects. Default: `console.error`. */
  onError?: (err: unknown) => void
}

/**
 * Buffer finished spans and events, handing them to `send` in batches.
 *
 * Exporters need this and should not each re-implement it: write a `send`,
 * get size- and time-based flushing plus a `flush()` that drains on demand.
 * `trace.flush()` reaches it through `compose`, which is how an exporter
 * avoids losing its tail at process exit.
 *
 * Records are snapshotted with `toJSON()` on the way in, so a span mutated
 * after exit cannot rewrite what is already queued.
 *
 * @example
 * ```ts
 * const otlp = batch((records) => fetch(endpoint, { method: 'POST', body: JSON.stringify(records) }))
 * defaultTrace.install(otlp)
 * await defaultTrace.flush() // before process exit
 * ```
 */
export const batch = (
  send: (records: (SpanBase | EventBase)[]) => void | Promise<void>,
  options: BatchOptions = {},
): Layer => {
  const size = options.size ?? 512
  const interval = options.interval ?? 5000
  const onError = options.onError ?? ((err: unknown) => console?.error(err))

  let buffer: (SpanBase | EventBase)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()

  const drain = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (buffer.length === 0) return inFlight
    const records = buffer
    buffer = []
    // Chain rather than race, so batches reach `send` in the order they filled
    // and `flush` awaits everything still outstanding.
    inFlight = inFlight.then(() => send(records)).catch(onError)
    return inFlight
  }

  const push = (record: SpanBase | EventBase): void => {
    buffer.push(record)
    if (buffer.length >= size) return void drain()
    if (timer === undefined) {
      timer = setTimeout(() => void drain(), interval)
      // Never hold the process open waiting to flush.
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  return {
    onExit: (span) => push(span.toJSON()),
    onEvent: (evt) => push(evt.toJSON()),
    flush: () => drain(),
  }
}
