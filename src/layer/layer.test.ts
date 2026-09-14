import { describe, expect, it, vi } from 'vitest'

import { Level, type Layer, type Span } from '../types.ts'
import { batch, compose, envFilter, filter, minLevel, sample } from './index.ts'
import { createTrace } from '../trace.ts'
import { capture } from '../test.ts'

describe('compose', () => {
  it('fans callbacks out to every layer in order', () => {
    const a = capture()
    const b = capture()
    const trace = createTrace({ layer: compose(a.layer, b.layer) })

    trace.span('op').in(() => trace.event('hi', Level.INFO))

    for (const side of [a, b]) {
      expect(side.entered).toHaveLength(1)
      expect(side.exited).toHaveLength(1)
      expect(side.events).toHaveLength(1)
    }
  })

  it("respects each layer's own minLevel", () => {
    const chatty = capture()
    const quiet = capture(Level.WARN)
    const trace = createTrace({ layer: compose(chatty.layer, quiet.layer) })

    trace.event('info', Level.INFO)
    trace.event('error', Level.ERROR)

    expect(chatty.messages()).toEqual(['info', 'error'])
    expect(quiet.messages()).toEqual(['error'])
  })

  it('skips a layer whose minLevel is above the span', () => {
    // The core gates spans on the composed floor (the least severe of all
    // layers), so a span at that floor is created and composed fans out — it
    // must still skip the high-floor layer.
    const low = vi.fn()
    const high = vi.fn()
    const trace = createTrace({
      layer: compose({ onEnter: low }, { onEnter: high, minLevel: Level.WARN }),
    })

    trace.span('op', Level.INFO).end()

    expect(low).toHaveBeenCalledTimes(1)
    expect(high).not.toHaveBeenCalled()
  })

  it('keeps per-layer span state isolated through a WeakMap', () => {
    const seen: string[] = []
    const mk = (tag: string): Layer => {
      const state = new WeakMap<Span, string>()
      return {
        onEnter: (span) => void state.set(span, `${tag}-state`),
        onExit: (span) => void seen.push(state.get(span)!),
      }
    }
    const trace = createTrace({ layer: compose(mk('a'), mk('b')) })

    trace.span('op').end()

    expect(seen).toEqual(['a-state', 'b-state'])
  })

  it('flushes every layer', async () => {
    const a = capture()
    const b = capture()
    const trace = createTrace({ layer: compose(a.layer, b.layer, {}) })

    await trace.flush()

    expect(a.flushes).toBe(1)
    expect(b.flushes).toBe(1)
  })

  it('does not alias a single layer', () => {
    const sink = capture()
    const composed = compose(sink.layer)
    composed.minLevel = Level.ERROR

    expect(sink.layer.minLevel).toBeUndefined()
  })
})

describe('minLevel', () => {
  it('gates a layer without mutating the original', () => {
    const sink = capture()
    const trace = createTrace({ layer: minLevel(Level.WARN, sink.layer) })

    trace.event('dropped', Level.INFO)
    trace.event('kept', Level.WARN)

    expect(sink.messages()).toEqual(['kept'])
    expect(sink.layer.minLevel).toBeUndefined()
  })
})

describe('filter', () => {
  it('hides rejected spans for their whole lifecycle and tests events one by one', () => {
    const sink = capture()
    const trace = createTrace({
      layer: filter((item) => (item.type === 'span' ? item.name !== 'noisy' : item.message !== 'dropped'), sink.layer),
    })

    trace.span('noisy').in(() => {})
    trace.span('fine').in(() => {})
    trace.event('dropped', Level.INFO)
    trace.event('kept', Level.INFO)

    expect(sink.names()).toEqual(['fine'])
    expect(sink.exited.map((s) => s.name)).toEqual(['fine'])
    expect(sink.messages()).toEqual(['kept'])
  })
})

describe('envFilter', () => {
  const run = (spec: string) => {
    const sink = capture()
    const trace = createTrace({ layer: envFilter(spec, sink.layer) })
    return { sink, trace }
  }

  it('applies the bare directive as the default floor', () => {
    const { sink, trace } = run('info')

    trace.event('dropped', Level.DEBUG)
    trace.event('kept', Level.INFO)
    trace.event('targeted', Level.INFO, {}, 'app:db')

    expect(sink.messages()).toEqual(['kept', 'targeted'])
  })

  it('lets a targeted directive lower the floor for its subtree only', () => {
    const { sink, trace } = run('info,app:db=debug')

    trace.event('a', Level.DEBUG)
    trace.event('b', Level.DEBUG, {}, 'app:db')
    trace.event('c', Level.DEBUG, {}, 'app:db:pool')
    trace.event('d', Level.DEBUG, {}, 'app:http')

    expect(sink.messages()).toEqual(['b', 'c'])
  })

  it('prefers the longest matching target', () => {
    const { sink, trace } = run('app=debug,app:db=warn')

    trace.event('a', Level.DEBUG, {}, 'app:http')
    trace.event('b', Level.DEBUG, {}, 'app:db')
    trace.event('c', Level.ERROR, {}, 'app:db')

    expect(sink.messages()).toEqual(['a', 'c'])
  })

  it('matches on segment boundaries, not raw prefixes', () => {
    const { sink, trace } = run('off,app=trace')

    trace.event('inside', Level.TRACE, {}, 'app:db')
    trace.event('lookalike', Level.TRACE, {}, 'apple')

    expect(sink.messages()).toEqual(['inside'])
  })

  it('silences a subtree with off, spans included', () => {
    const { sink, trace } = run('trace,app:health=off')

    trace.scope('check', () => {}, Level.INFO, {}, 'app:health')
    trace.scope('work', () => {}, Level.INFO, {}, 'app:db')

    expect(sink.names()).toEqual(['work'])
    expect(sink.exited.map((s) => s.name)).toEqual(['work'])
  })
})

describe('sample', () => {
  it('keeps or drops a whole trace together', () => {
    // Halve the space, then check every span/event of a trace agrees.
    const sink = capture()
    const trace = createTrace({ layer: sample(0.5, sink.layer) })

    for (let i = 0; i < 40; i++) {
      trace.scope(`op-${i}`, (sp) => {
        sp.child('child').end()
        trace.event('inner', Level.INFO)
      })
    }

    const traceIds = new Set(sink.entered.map((s) => s.traceId))
    for (const evt of sink.events) expect(traceIds.has(evt.traceId)).toBe(true)

    // Both outcomes actually occur over 40 traces.
    expect(sink.entered.length).toBeGreaterThan(0)
    expect(sink.entered.length).toBeLessThan(80)
  })

  it('passes everything at rate 1 and nothing at rate 0', () => {
    const all = capture()
    const none = capture()
    createTrace({ layer: sample(1, all.layer) }).event('a', Level.INFO)
    createTrace({ layer: sample(0, none.layer) }).event('b', Level.INFO)

    expect(all.messages()).toEqual(['a'])
    expect(none.messages()).toEqual([])
  })
})

describe('batch', () => {
  it('flushes on size and drains the remainder on flush()', async () => {
    const sent: unknown[][] = []
    const trace = createTrace({ layer: batch((records) => void sent.push(records), { size: 2, interval: 60_000 }) })

    trace.event('one', Level.INFO)
    trace.event('two', Level.INFO)

    // Reaching `size` schedules the send; `flush` awaits it even though the
    // buffer is already empty.
    await trace.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(2)

    trace.event('three', Level.INFO)
    await trace.flush()

    expect(sent).toHaveLength(2)
    expect(sent[1]).toHaveLength(1)
  })

  it('flushes on the interval', async () => {
    vi.useFakeTimers()
    try {
      const sent: unknown[][] = []
      const trace = createTrace({ layer: batch((records) => void sent.push(records), { size: 100, interval: 50 }) })

      trace.event('one', Level.INFO)
      expect(sent).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(50)
      expect(sent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends serialized snapshots, not live spans', async () => {
    const sent: Record<string, unknown>[] = []
    const trace = createTrace({ layer: batch((records) => void sent.push(...(records as never[])), { size: 1 }) })

    const sp = trace.span('op', Level.INFO, { stage: 'start' })
    sp.end()
    sp.setFields({ stage: 'after-exit' })
    await trace.flush()

    expect(sent[0]).toMatchObject({ type: 'span', name: 'op', fields: { stage: 'start' } })
    expect(sent[0]).not.toBe(sp)
  })

  it('reports a failing send without breaking the pipeline', async () => {
    const onError = vi.fn()
    const trace = createTrace({
      layer: batch(() => Promise.reject(new Error('network')), { size: 1, onError }),
    })

    trace.event('one', Level.INFO)
    await trace.flush()

    expect(onError).toHaveBeenCalledTimes(1)
    // Still usable afterwards.
    trace.event('two', Level.INFO)
    await trace.flush()
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
