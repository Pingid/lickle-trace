/**
 * Test helpers.
 *
 * @example
 * ```ts
 * import { createTrace } from '@lickle/trace'
 * import { capture } from '@lickle/trace/test'
 *
 * const sink = capture()
 * const trace = createTrace({ layer: sink.layer })
 *
 * trace.scope('work', () => trace.event('done'))
 * expect(sink.names()).toEqual(['work'])
 * expect(sink.messages()).toEqual(['done'])
 * ```
 */
import type { Event, Layer, Span } from './types.ts'

/** A layer that records everything it receives, for assertions. */
export interface Capture {
  /** Install this on the trace under test. */
  layer: Layer
  /** Spans in the order they were entered. */
  entered: Span[]
  /** Spans in the order they exited. */
  exited: Span[]
  /** Events in emission order. */
  events: Event[]
  /** Names of entered spans. */
  names(): string[]
  /** Messages of captured events. */
  messages(): (string | undefined)[]
  /** Number of times `flush` was called on the layer. */
  flushes: number
  /** Drop everything recorded so far. */
  clear(): void
}

/** Create a recording {@link Layer} plus the buffers it writes into. */
export const capture = (minLevel?: Layer['minLevel']): Capture => {
  const entered: Span[] = []
  const exited: Span[] = []
  const events: Event[] = []

  const self: Capture = {
    layer: {
      ...(minLevel ? { minLevel } : {}),
      onEnter: (span) => void entered.push(span),
      onExit: (span) => void exited.push(span),
      onEvent: (evt) => void events.push(evt),
      flush: () => void (self.flushes += 1),
    },
    entered,
    exited,
    events,
    flushes: 0,
    names: () => entered.map((s) => s.name),
    messages: () => events.map((e) => e.message),
    clear() {
      entered.length = 0
      exited.length = 0
      events.length = 0
      self.flushes = 0
    },
  }

  return self
}
