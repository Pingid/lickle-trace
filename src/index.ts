/**
 * The tracing core: spans, events, and the layer they are delivered to.
 *
 * Nothing is output until a layer is installed.
 *
 * @example
 * ```ts
 * import { defaultTrace } from '@lickle/trace'
 * import { Console } from '@lickle/trace/layer'
 * import { info, span } from '@lickle/trace/log'
 *
 * defaultTrace.install(Console.layer())
 *
 * info`request ${id} done`
 * span.debug('op', { id }, async () => { ... })
 * ```
 */

export { Level, severity } from './types.ts'
export type { Base, Event, EventBase, Fields, Layer, Registry, Span, SpanBase, Trace, TraceContext } from './types.ts'

export { createTrace, adoptSpan, adoptEvent, linkSpan, default as defaultTrace } from './trace.ts'

export { registry, stackRegistry, alsRegistry, asyncSupported, type RegistryOptions } from './registry.ts'
