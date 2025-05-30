import { Event, Level, Span, Subscriber, Trace, setSubscriber } from './trace.js'
import { now, uuid } from './util.js'

/**
 * Builder for creating and configuring trace subscribers.
 * @example
 * const builder = new Builder()
 *   .withMinLevel(Level.INFO)
 *   .withLayer(new ConsoleLayer())
 *   .install();
 */
export class Builder {
  private minLevel = Level.TRACE
  private layers: Subscriber[] = []

  /**
   * Sets the minimum log level for the subscriber.
   * @example
   * builder.withMinLevel(Level.INFO);
   */
  withMinLevel(level: Level) {
    this.minLevel = level
    return this
  }

  /**
   * Adds a subscriber layer to handle trace events.
   * @example
   * builder.withLayer(new ConsoleLayer());
   */
  withLayer(sub: Subscriber) {
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
  install(trace?: Trace) {
    const sub: Subscriber = {
      minLevel: this.minLevel,
      newSpan: (meta) => {
        const layer = this.layers.find((x) => x.newSpan)
        if (!layer) return { id: uuid(), meta }
        return layer.newSpan!(meta)
      },
      onEnter: (sp) => this.layers.forEach((l) => l.onEnter?.(sp)),
      onExit: (sp) => this.layers.forEach((l) => l.onExit?.(sp)),
      onEvent: (evt) => this.layers.forEach((l) => l.onEvent?.(evt)),
    }
    if (!trace) return setSubscriber(sub)
    // @ts-ignore
    return (trace.sub = sub)
  }
}

/** Maps log levels to their string representations */
const levels = {
  [Level.TRACE]: 'TRACE',
  [Level.DEBUG]: 'DEBUG',
  [Level.INFO]: 'INFO',
  [Level.WARN]: 'WARN',
  [Level.ERROR]: 'ERROR',
}

/**
 * Console subscriber that logs spans and events to the console.
 * Uses appropriate console methods based on log level.
 * @example
 * const consoleLayer = new ConsoleLayer();
 * new Builder().withLayer(consoleLayer).install();
 */
export class ConsoleLayer implements Subscriber {
  /**
   * Logs when a span is entered.
   * @example
   * // Output: [INFO] [SPAN:ENTER] (process-request) { requestId: '123' }
   */
  onEnter(span: Span) {
    console.log(`[${levels[span.meta.level]}] [SPAN:ENTER] (${span.meta.name})`, span.meta.fields)
  }

  /**
   * Logs when a span is exited, including its duration.
   * @example
   * // Output: [INFO] [SPAN:EXIT] (process-request) (123.45ms) { requestId: '123' }
   */
  onExit(span: Span) {
    const duration = now() - span.meta.ts
    console.log(
      `[${levels[span.meta.level]}] [SPAN:EXIT] (${span.meta.name}) (${duration.toFixed(2)}ms)`,
      span.meta.fields,
    )
  }

  /**
   * Logs events using appropriate console methods based on level.
   * @example
   * // Output: [INFO] (user-login): User logged in { userId: '123' }
   */
  onEvent(e: Event) {
    const args = [`[${levels[e.meta.level]}] (${e.meta.name ?? ''}):`, e.message || '', e.meta.fields]
    if (e.meta.level === Level.ERROR) return console.error(...args)
    if (e.meta.level === Level.WARN) return console.warn(...args)
    if (e.meta.level === Level.INFO) return console.info(...args)
    if (e.meta.level === Level.DEBUG) return console.debug(...args)
    if (e.meta.level === Level.TRACE) return console.trace(...args)
    console.log(...args)
  }
}
