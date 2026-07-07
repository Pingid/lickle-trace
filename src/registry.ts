import { Event, Metadata, Span, Layer, Trace, setSubscriber, Context, Levels, Level } from './trace.js'

export type LayerFilter = (kind: 'event' | 'span', meta: Metadata) => boolean

/**
 * Registry for configuring and installing layered subscribers.
 * @example
 * const consoleLayer = new ConsoleLayer()
 * new Registry()
 *   .minLevel('info')
 *   .filter(envFilter('app=info'))
 *   .layer(consoleLayer, envFilter('db=warn,[{requestId}]=debug'))
 *   .install()
 */
export class Registry {
  private layers: Array<{ layer: Layer; filter?: LayerFilter | undefined }> = []
  private globals: LayerFilter[] = []
  private min: Level = 'trace'

  minLevel(level: Level): Registry {
    this.min = level
    return this
  }

  filter(f: LayerFilter): Registry {
    this.globals.push(f)
    return this
  }

  layer(layer: Layer, filter?: LayerFilter): Registry {
    this.layers.push({ layer, filter })
    return this
  }

  install(trace?: Trace): void {
    const apply = <E extends Event | Span>(kind: 'event' | 'span', e: E, _cx: Context, f: (l: Layer) => void) => {
      if (Levels[e.meta.level] < Levels[this.min]) return
      if (this.globals.length && !this.globals.every((g) => g(kind, e.meta))) return
      for (const { layer, filter } of this.layers) {
        if (Levels[e.meta.level] < Levels[layer.minLevel ?? 'trace']) continue
        if (filter && !filter(kind, e.meta)) continue
        f(layer)
      }
    }

    const ns = this.layers.find((x) => x.layer.newSpan)?.layer.newSpan

    const sub: Layer = {
      minLevel: this.min,
      newSpan: ns,
      onEnter: (sp, cx) => apply('span', sp, cx, (l) => l.onEnter?.(sp, cx)),
      onExit: (sp, cx) => apply('span', sp, cx, (l) => l.onExit?.(sp, cx)),
      onClose: (sp, cx) => apply('span', sp, cx, (l) => l.onClose?.(sp, cx)),
      onEvent: (evt, cx) => apply('event', evt, cx, (l) => l.onEvent?.(evt, cx)),
      onRecord: (sp, cx, fields) => apply('span', sp, cx, (l) => l.onRecord?.(sp, cx, fields)),
    }
    if (!trace) return setSubscriber(sub)
    trace.setSubscriber(sub)
  }
}
