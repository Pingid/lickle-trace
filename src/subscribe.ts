import { Event, Fields, Level, Metadata, Span, Subscriber, Trace, setSubscriber } from './trace.js'
import { now, uuid } from './util.js'

type FilterFn = (type: 'event' | 'span', level: Level, meta: Metadata) => boolean

/**
 * Builder for creating and configuring trace subscribers.
 * @example
 * const builder = new Builder()
 *   .withMinLevel(Level.INFO)
 *   .withLayer(new ConsoleLayer())
 *   .install();
 */
export class Builder {
  private filters: FilterFn[] = []
  private minLevel = Level.TRACE
  private layers: Subscriber[] = []

  withFilter(filter: FilterFn): Builder {
    this.filters.push(filter)
    return this
  }

  /**
   * Adds a subscriber layer to handle trace events.
   * @example
   * builder.withLayer(new ConsoleLayer());
   */
  withLayer(sub: Subscriber): Builder {
    this.layers.push(sub)
    return this
  }

  /**
   * Installs the configured subscriber into a trace instance.
   * If no trace is provided, installs into the default trace.
   * @example
   * builder.install(); // installs to default trace
   * builder.install(customTrace); // installs to custom trace
   */
  install(trace?: Trace): void {
    const filter = <E extends Event | Span>(event: E, f: (x: E) => void): boolean => {
      if (this.filters.length === 0) return true
      for (const filter of this.filters) {
        if (filter(event.type, event.meta.level, event.meta)) {
          f(event)
          return true
        }
      }
      return false
    }
    const sub: Subscriber = {
      minLevel: this.minLevel,
      newSpan: (meta) => {
        const layer = this.layers.find((x) => x.newSpan)
        if (!layer) return { id: uuid(), meta, type: 'span' }
        return layer.newSpan!(meta)
      },
      onEnter: (sp) => filter(sp, () => this.layers.forEach((l) => l.onEnter?.(sp))),
      onExit: (sp) => filter(sp, () => this.layers.forEach((l) => l.onExit?.(sp))),
      onEvent: (evt) => filter(evt, () => this.layers.forEach((l) => l.onEvent?.(evt))),
    }
    if (!trace) return setSubscriber(sub)
    // @ts-ignore
    return (trace.sub = sub)
  }
}

/** Maps log levels to their string representations */
const levels = {
  [Level.TRACE]: 'trace',
  [Level.DEBUG]: 'debug',
  [Level.INFO]: 'info',
  [Level.WARN]: 'warn',
  [Level.ERROR]: 'error',
} as const

/**
 * Console subscriber that logs spans and events to the console.
 * Uses appropriate console methods based on log level.
 * @example
 * const consoleLayer = new ConsoleLayer();
 * new Builder().withLayer(consoleLayer).install();
 */
/**
 * Console subscriber that logs spans and events to the console.
 * Uses appropriate console methods based on log level.
 * @example
 * const consoleLayer = new ConsoleLayer();
 * new Builder().withLayer(consoleLayer).install();
 */
export class ConsoleLayer implements Subscriber {
  constructor(
    private print: (level: (typeof levels)[keyof typeof levels], message: string, fields?: Fields) => void = (
      level,
      message,
      fields,
    ) => {
      if (fields) console?.[level](message, fields)
      else console?.[level](message)
    },
  ) {}

  private log(level: Level, message: string, fields?: Fields) {
    const name = levels[level]
    this.print(name, message, fields)
  }

  /** Logs when a span is entered. */
  onEnter(span: Span) {
    this.log(span.meta.level, `enter -> (${span.meta.name})`, span.meta.fields)
  }

  /**
   * Logs when a span is exited, including its duration.
   * @example
   * // Output: [INFO] [SPAN:EXIT] (process-request) (123.45ms) { requestId: '123' }
   */
  onExit(span: Span) {
    const duration = now() - span.meta.ts
    this.log(span.meta.level, `exit <- (${span.meta.name}) ${duration.toFixed(2)}ms`, span.meta.fields)
  }

  /**
   * Logs events using appropriate console methods based on level.
   * @example
   * // Output: [INFO] (user-login): User logged in { userId: '123' }
   */
  onEvent(e: Event): void {
    this.log(e.meta.level, `${e.meta.name ? `(${e.meta.name})` : ''}${e.message ? ` ${e.message}` : ''}`, e.meta.fields)
  }
}
