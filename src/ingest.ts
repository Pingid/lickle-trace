/**
 * Ingestion boundary for spans and events originating in another context —
 * another Trace instance, another runtime, the Rust `tracing` bridge over wasm.
 *
 * This lives outside the core because most programs never bridge anything, and
 * the boundary's in-flight index would otherwise be allocated on every Trace.
 * It is built entirely on the public `adoptSpan` / `adoptEvent` primitives, so
 * a different boundary policy can be written the same way.
 *
 * @example
 * ```ts
 * import { defaultTrace } from '@lickle/trace'
 * import { createIngest } from '@lickle/trace/ingest'
 *
 * const ingest = createIngest(defaultTrace)
 * wasm.onRecord((record) => {
 *   if (record.type === 'event') ingest.event(record)
 *   else record.endTimestamp ? ingest.exit(record) : ingest.enter(record)
 * })
 * ```
 */
import { adoptEvent, adoptSpan } from './trace.ts'
import type { EventBase, Span, SpanBase, Trace } from './types.ts'

/**
 * Receives the wire shapes of foreign spans and events.
 *
 * The boundary owns the index of foreign spans currently in flight: a span
 * entered here is hydrated once, made current, and remembered until its `exit`
 * arrives, so events referencing it can resolve `parent`. The index holds only
 * in-flight spans — an exit removes the entry, and events whose parent already
 * exited resolve `parent: undefined` while keeping `parentId`.
 */
export interface Ingest {
  event(evt: EventBase): void
  enter(span: SpanBase): void
  exit(span: SpanBase): void
}

/** Create an {@link Ingest} boundary feeding `trace`. */
export const createIngest = (trace: Trace): Ingest => {
  const active = new Map<string, Span>()

  return {
    enter(sb) {
      if (active.has(sb.id)) return // idempotent re-entry
      const sp = adoptSpan(trace, sb, sb.parentId !== undefined ? active.get(sb.parentId) : undefined)
      if (sp) active.set(sp.id, sp) // absent when filtered out by level
    },
    exit(sb) {
      const sp = active.get(sb.id)
      if (!sp) return // unknown, filtered at enter, or already exited
      active.delete(sb.id)
      sp.end() // idempotent; removes from the registry and fires onExit
    },
    event(eb) {
      adoptEvent(trace, eb, eb.parentId !== undefined ? active.get(eb.parentId) : undefined)
    },
  }
}
