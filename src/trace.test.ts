import { describe, expect, it } from 'vitest'

import { Level, type Event, type Layer, type Span } from './types.ts'
import { createTrace } from './trace.ts'

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

describe('Trace', () => {
  it('parents spans through the active stack', () => {
    const { layer } = collect()
    const trace = createTrace({ layer })

    const root = trace.span('root')
    const child = trace.span('child')

    expect(child.parentId).toBe(root.id)
    expect(root.parentId).toBeUndefined()

    child.end()
    expect(trace.current()).toBe(root)
    root.end()
    expect(trace.current()).toBeUndefined()
  })

  it('attributes events to the active span', () => {
    const { layer, events } = collect()
    const trace = createTrace({ layer })

    trace.event('outside', Level.INFO)
    trace.span('op').in(() => trace.event('inside', Level.INFO))

    expect(events[0]?.parentId).toBeUndefined()
    expect(events[1]?.id).toBeDefined()
  })

  it('filters below minLevel with inert no-op spans', () => {
    const { layer, entered, exited, events } = collect()
    const trace = createTrace({ layer: { ...layer, minLevel: Level.INFO } })

    trace.event('quiet', Level.DEBUG, { dropped: true })
    const sp = trace.span('quiet', Level.DEBUG)
    sp.setFields({ a: 1 })
    sp.in(() => {})
    sp.end()

    expect(events).toHaveLength(0)
    expect(entered).toHaveLength(0)
    expect(exited).toHaveLength(0)
    expect(sp.id).toBe('')
  })

  it('parents an enabled child of a filtered-out span correctly', () => {
    const { layer } = collect()
    const trace = createTrace({ layer: { ...layer, minLevel: Level.INFO } })

    const root = trace.span('root')
    const quiet = trace.span('quiet', Level.DEBUG)
    const child = quiet.child('loud', Level.WARN)

    expect(child.parentId).toBe(root.id)
    child.end()
    root.end()
  })

  it('exit is idempotent and fires onExit exactly once', () => {
    const { layer, exited } = collect()
    const trace = createTrace({ layer })

    const sp = trace.span('once')
    sp.end()
    sp.end()
    trace.exit(sp)

    expect(exited).toHaveLength(1)
  })

  it('scope ends the span on return, throw, and async settle', async () => {
    const { layer, exited } = collect()
    const trace = createTrace({ layer })

    expect(trace.scope('sync', () => 7)).toBe(7)
    expect(() =>
      trace.scope('throws', () => {
        throw new Error('nope')
      }),
    ).toThrow('nope')
    await expect(trace.scope('async', async () => 'ok')).resolves.toBe('ok')

    expect(exited.map((s) => s.name)).toEqual(['sync', 'throws', 'async'])
    expect(trace.current()).toBeUndefined()
  })

  it('uses the injected clock and id generator', () => {
    let ticks = 0
    const trace = createTrace({ now: () => ++ticks, uid: () => `id-${++ticks}` })

    const sp = trace.span('op')
    expect(sp.id).toMatch(/^id-/)
    expect(sp.timestamp).toBeGreaterThan(0)
  })

  it('supports `using` disposal', () => {
    const { layer, exited } = collect()
    const trace = createTrace({ layer })

    {
      using sp = trace.span('scoped')
      expect(sp.id).not.toBe('')
    }

    expect(exited).toHaveLength(1)
  })
})
