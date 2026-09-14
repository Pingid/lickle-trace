import { print as defaultPrint, type PrintFn } from './util.ts'
import type { Event, Fields, Layer, Span, Trace } from '../types.ts'

export type { PrintFn }

/** What a formatter hands to {@link PrintFn}: a line, and fields to expand. */
export type Formatted = [message: string, fields?: Fields | undefined]

/** Renders a span lifecycle transition or an event into a printable line. */
export interface Format {
  enter(span: Span, trace: Trace): Formatted
  exit(span: Span, trace: Trace): Formatted
  event(evt: Event, trace: Trace): Formatted
}

const tag = (target?: string): string => (target ? `${target} ` : '')

/** Don't print an empty `{}` after every line that carries no fields. */
const some = (fields?: Fields): Fields | undefined => (fields && Object.keys(fields).length > 0 ? fields : undefined)

const duration = (span: Span, trace: Trace): string =>
  `${((span.endTimestamp ?? trace.context.now()) - span.timestamp).toFixed(2)}ms`

/**
 * Human-readable output, one line per transition. The default.
 *
 * @example
 * ```
 * enter -> (handle-request) { path: '/users' }
 * exit <- (handle-request) 12.34ms { path: '/users' }
 * ```
 */
export const pretty: Format = {
  enter: (span) => [`${tag(span.target)}enter -> (${span.name})`, some(span.fields)],
  exit: (span, trace) => [`${tag(span.target)}exit <- (${span.name}) ${duration(span, trace)}`, some(span.fields)],
  event: (evt) => [`${tag(evt.target)}${evt.message ?? ''}`, some(evt.fields)],
}

/**
 * One JSON object per line (NDJSON) — what log shippers and `jq` expect.
 *
 * Spans are emitted once, on exit, with `endTimestamp` already set, so each
 * line is a complete record rather than a matched pair.
 */
export const json: Format = {
  enter: () => ['', undefined],
  exit: (span) => [JSON.stringify(span), undefined],
  event: (evt) => [JSON.stringify(evt), undefined],
}

export interface ConsoleOptions {
  /** How to render each item. Default {@link pretty}. */
  format?: Format
  /** Where to write. Default: the `console` method matching the level. */
  print?: PrintFn
}

/**
 * A layer that prints spans and events to the console, using the console
 * method matching each item's level.
 *
 * @example
 * ```ts
 * import { Console } from '@lickle/trace/layer'
 *
 * defaultTrace.install(Console.layer())                          // pretty
 * defaultTrace.install(Console.layer({ format: Console.json }))  // NDJSON
 * ```
 */
export const layer = (options: ConsoleOptions = {}): Layer => {
  const format = options.format ?? pretty
  const out = options.print ?? defaultPrint
  const write = (level: Span['level'], [message, fields]: Formatted): void => {
    // A formatter opts out of a transition by returning an empty line —
    // `json` does this for `enter`, since it emits one record on exit.
    if (message !== '') out(level, message, fields)
  }

  return {
    onEnter: (span, trace) => write(span.level, format.enter(span, trace)),
    onExit: (span, trace) => write(span.level, format.exit(span, trace)),
    onEvent: (evt, trace) => write(evt.level, format.event(evt, trace)),
  }
}
