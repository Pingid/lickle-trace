import { Level, type Event, type Layer, type Span } from '../types.ts'
import { enabled } from '../util.ts'

export * as Console from './console.ts'

/**
 * Combine several layers into one. Callbacks fan out in declaration order,
 * and each layer's own `minLevel` is still respected, so layers with
 * different floors can share one trace.
 *
 * Span extension state is kept per layer: while a layer's callback runs,
 * `span.ext` reads and writes that layer's own slot, so composed layers
 * never see each other's state.
 *
 * @example
 * ```ts
 * defaultTrace.install(compose(minLevel(Level.WARN, Console.layer()), otlpLayer))
 * ```
 */
export const compose = (...layers: Layer[]): Layer => {
  if (layers.length === 0) return {}
  if (layers.length === 1) return layers[0]!

  const each = (level: Level, fn: (layer: Layer, i: number) => void): void => {
    for (let i = 0; i < layers.length; i++) if (enabled(level, layers[i])) fn(layers[i]!, i)
  }
  // Swap layer `i`'s ext slot into `span.ext` while `fn` runs.
  const withExt = (span: Span, i: number, fn: () => void): void => {
    const exts = span.ext as unknown[] | undefined
    span.ext = exts?.[i]
    try {
      fn()
    } finally {
      if (exts) exts[i] = span.ext
      span.ext = exts
    }
  }

  const composed: Layer = {
    minLevel: Math.min(...layers.map((l) => l.minLevel ?? Level.TRACE)),
    newSpan(span, trace) {
      const exts = new Array<unknown>(layers.length)
      each(span.level, (l, i) => {
        exts[i] = l.newSpan?.(span, trace)
      })
      return exts
    },
    onEnter(span, trace) {
      each(span.level, (l, i) => withExt(span, i, () => l.onEnter?.(span, trace)))
    },
    onExit(span, trace) {
      each(span.level, (l, i) => withExt(span, i, () => l.onExit?.(span, trace)))
    },
    onEvent(evt, trace) {
      each(evt.level, (l) => l.onEvent?.(evt, trace))
    },
  }
  return composed
}

/**
 * Return a copy of `layer` gated to `level` and above.
 *
 * @example
 * ```ts
 * defaultTrace.install(minLevel(Level.INFO, Console.layer()))
 * ```
 */
export const minLevel = <S>(level: Level, layer: Layer<S>): Layer<S> => ({ ...layer, minLevel: level })

/**
 * Wrap `layer` so it only receives spans and events for which `pred` returns
 * true. A span rejected at creation is hidden from the layer for its whole
 * lifecycle (no `newSpan`/`onEnter`/`onExit`); events are tested one by one.
 *
 * @example
 * ```ts
 * defaultTrace.install(filter((item) => item.type !== 'span' || item.name !== 'noisy', Console.layer()))
 * ```
 */
export const filter = <S>(pred: (item: Span | Event) => boolean, layer: Layer<S>): Layer<S> => {
  // Rejected spans are remembered for their whole lifecycle and only released
  // by GC. This is not a leak: WeakSet membership cannot outlive the span
  // itself, so even a hidden span that is never ended costs nothing once the
  // span becomes unreachable.
  const hidden = new WeakSet<object>()
  return {
    minLevel: layer.minLevel,
    newSpan(span, trace) {
      if (!pred(span)) {
        hidden.add(span)
        return undefined
      }
      return layer.newSpan?.(span, trace)
    },
    onEnter(span, trace) {
      if (!hidden.has(span)) layer.onEnter?.(span, trace)
    },
    onExit(span, trace) {
      if (!hidden.has(span)) layer.onExit?.(span, trace)
    },
    onEvent(evt, trace) {
      if (pred(evt)) layer.onEvent?.(evt, trace)
    },
  }
}
