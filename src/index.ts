/**
 *
 * @example
 * ```ts
 * import { init, info, span, debug } from '@lickle/trace'
 *
 * init()
 *
 * info`request ${id} done`
 * span.debug('op', { id }, async () => { ... })
 * debug({ id })`request ${id} done`
 * ```
 */

import { Console } from './layer/index.ts'
import trace from './trace.ts'

export function init() {
  trace.install(Console.layer())
}

export { default as log, createLog, trace, debug, info, warn, error, span } from './log.ts'
export { default as defaultTrace } from './trace.ts'
export * from './trace.ts'
