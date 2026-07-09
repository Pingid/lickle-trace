import { print as defaultPrint } from './util/node.ts'

import { Level, type Fields, type Layer } from '../types.ts'

export type PrintFn = (level: Level, message: string, fields?: Fields) => void

/**
 * A layer that prints spans and events to the console, using the console
 * method matching each item's level. Span exits include the duration.
 *
 * Pass `print` to redirect the output (e.g. into a test buffer or custom sink).
 */
export const layer = (print: PrintFn = defaultPrint): Layer => ({
  onEnter(span) {
    print(span.level, `enter -> (${span.name})`, span.fields)
  },
  onExit(span, trace) {
    const duration = trace.context.now() - span.timestamp
    print(span.level, `exit <- (${span.name}) ${duration.toFixed(2)}ms`, span.fields)
  },
  onEvent(e): void {
    print(e.level, `${e.message ? ` ${e.message}` : ''}`, e.fields)
  },
})
