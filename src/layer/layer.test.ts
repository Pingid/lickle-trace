import { describe, expect, it, vi } from 'vitest'

import { Level, type Event, type Layer, type Span } from '../types.ts'
import { compose, filter, minLevel } from './index.ts'
import { createTrace } from '../trace.ts'

const collect = () => {
  const entered: Span[] = []
  const exited: Span[] = []
  const events: Event[] = []
  const layer: Layer = {
    onEnter: (span) => void entered.push(span),
    onExit: (span) => void exited.push(span),
    onEvent: (evt) => void events.push(evt),
  }
  return { layer, entered, exited, events }
}

describe('compose', () => {
  it('fans callbacks out to every layer in order', () => {
    const a = collect()
    const b = collect()
    const trace = createTrace({ layer: compose(a.layer, b.layer) })

    trace.span('op').in(() => trace.event('hi', Level.INFO))

    for (const side of [a, b]) {
      expect(side.entered).toHaveLength(1)
      expect(side.exited).toHaveLength(1)
      expect(side.events).toHaveLength(1)
    }
  })

  it("respects each layer's own minLevel", () => {
    const chatty = collect()
    const quiet = collect()
    const trace = createTrace({
      layer: compose(chatty.layer, { ...quiet.layer, minLevel: Level.WARN }),
    })

    trace.event('info', Level.INFO)
    trace.event('error', Level.ERROR)

    expect(chatty.events.map((e) => e.message)).toEqual(['info', 'error'])
    expect(quiet.events.map((e) => e.message)).toEqual(['error'])
  })

  it('skips newSpan for layers whose minLevel is above the span', () => {
    // The core gates spans on the composed minLevel (the min of all layers),
    // so a span at that floor is created and composed.newSpan runs — it must
    // skip the high-floor child even though the core called it.
    const low = vi.fn()
    const high = vi.fn()
    const trace = createTrace({
      layer: compose({ newSpan: low }, { newSpan: high, minLevel: Level.WARN }),
    })

    trace.span('op', Level.INFO).end()

    expect(low).toHaveBeenCalledTimes(1)
    expect(high).not.toHaveBeenCalled()
  })

  it('keeps span.ext isolated per layer', () => {
    const seen: unknown[] = []
    const mk = (tag: string): Layer<string> => ({
      newSpan: () => `${tag}-state`,
      onExit: (span) => void seen.push(span.ext),
    })
    const trace = createTrace({ layer: compose(mk('a') as Layer, mk('b') as Layer) })

    trace.span('op').end()

    expect(seen).toEqual(['a-state', 'b-state'])
  })
})

describe('minLevel', () => {
  it('gates a layer without mutating the original', () => {
    const { layer, events } = collect()
    const gated = minLevel(Level.WARN, layer)
    const trace = createTrace({ layer: gated })

    trace.event('dropped', Level.INFO)
    trace.event('kept', Level.WARN)

    expect(events.map((e) => e.message)).toEqual(['kept'])
    expect(layer.minLevel).toBeUndefined()
  })
})

describe('filter', () => {
  it('hides rejected spans for their whole lifecycle and tests events one by one', () => {
    const { layer, entered, exited, events } = collect()
    const trace = createTrace({
      layer: filter((item) => (item.type === 'span' ? item.name !== 'noisy' : item.message !== 'dropped'), layer),
    })

    trace.span('noisy').in(() => {})
    trace.span('fine').in(() => {})
    trace.event('dropped', Level.INFO)
    trace.event('kept', Level.INFO)

    expect(entered.map((s) => s.name)).toEqual(['fine'])
    expect(exited.map((s) => s.name)).toEqual(['fine'])
    expect(events.map((e) => e.message)).toEqual(['kept'])
  })
})
