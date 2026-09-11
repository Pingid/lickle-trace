import { describe, expect, it, vi } from 'vitest'

import { Level } from './types.ts'
import { createTrace, adoptSpan, linkSpan } from './trace.ts'
import { capture } from './test.ts'

describe('Trace', () => {
  it('parents spans through the active stack', () => {
    const trace = createTrace({ layer: capture().layer })

    const root = trace.span('root')
    const child = trace.span('child')

    expect(child.parentId).toBe(root.id)
    expect(root.parentId).toBeUndefined()

    child.end()
    expect(trace.current()).toBe(root)
    root.end()
    expect(trace.current()).toBeUndefined()
  })

  it('mints a traceId at the root and inherits it down the tree', () => {
    const trace = createTrace({ layer: capture().layer })

    const root = trace.span('root')
    const child = root.child('child')
    const grandchild = child.child('grandchild')

    expect(root.traceId).toBeTruthy()
    expect(child.traceId).toBe(root.traceId)
    expect(grandchild.traceId).toBe(root.traceId)

    const other = createTrace({ layer: capture().layer }).span('elsewhere')
    expect(other.traceId).not.toBe(root.traceId)
  })

  it('attributes events to the active span and shares its traceId', () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    trace.event('outside', Level.INFO)
    const sp = trace.span('op')
    sp.in(() => trace.event('inside', Level.INFO))

    expect(sink.events[0]?.parentId).toBeUndefined()
    expect(sink.events[0]?.traceId).toBeTruthy()
    expect(sink.events[1]?.parentId).toBe(sp.id)
    expect(sink.events[1]?.traceId).toBe(sp.traceId)
  })

  it('filters below minLevel with inert no-op spans', () => {
    const sink = capture(Level.INFO)
    const trace = createTrace({ layer: sink.layer })

    trace.event('quiet', Level.DEBUG, { dropped: true })
    const sp = trace.span('quiet', Level.DEBUG)
    sp.setFields({ a: 1 })
    sp.in(() => {})
    sp.end()

    expect(sink.events).toHaveLength(0)
    expect(sink.entered).toHaveLength(0)
    expect(sink.exited).toHaveLength(0)
    expect(sp.id).toBe('')
  })

  it('parents an enabled child of a filtered-out span correctly', () => {
    const trace = createTrace({ layer: capture(Level.INFO).layer })

    const root = trace.span('root')
    const quiet = trace.span('quiet', Level.DEBUG)
    const child = quiet.child('loud', Level.WARN)

    expect(child.parentId).toBe(root.id)
    expect(child.traceId).toBe(root.traceId)
    child.end()
    root.end()
  })

  it('exit is idempotent and fires onExit exactly once', () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    const sp = trace.span('once')
    sp.end()
    sp.end()

    expect(sink.exited).toHaveLength(1)
  })

  it('records endTimestamp on exit, before the layer sees it', () => {
    const sink = capture()
    let clock = 100
    const trace = createTrace({ layer: sink.layer, now: () => (clock += 5) })

    const seen: (number | undefined)[] = []
    trace.install({ ...sink.layer, onExit: (span) => void seen.push(span.endTimestamp) })

    const sp = trace.span('timed')
    sp.end()

    expect(sp.endTimestamp).toBeGreaterThan(sp.timestamp)
    expect(seen[0]).toBe(sp.endTimestamp)
  })

  it('scope ends the span on return, throw, and async settle', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    expect(trace.scope('sync', () => 7)).toBe(7)
    expect(() =>
      trace.scope('throws', () => {
        throw new Error('nope')
      }),
    ).toThrow('nope')
    await expect(trace.scope('async', async () => 'ok')).resolves.toBe('ok')

    expect(sink.exited.map((s) => s.name)).toEqual(['sync', 'throws', 'async'])
    expect(trace.current()).toBeUndefined()
  })

  it('records the cause on a span whose scope throws or rejects', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    expect(() =>
      trace.scope('sync', () => {
        throw new Error('sync boom')
      }),
    ).toThrow('sync boom')

    await expect(
      trace.scope('async', async () => {
        throw new Error('async boom')
      }),
    ).rejects.toThrow('async boom')

    await expect(trace.scope('rejects', () => Promise.reject('not an error'))).rejects.toBe('not an error')

    expect(sink.exited[0]?.fields?.['error']).toMatchObject({ name: 'Error', message: 'sync boom' })
    expect(sink.exited[1]?.fields?.['error']).toMatchObject({ name: 'Error', message: 'async boom' })
    expect(sink.exited[2]?.fields?.['error']).toBe('not an error')
  })

  it('leaves a successful span without an error field', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    await trace.scope('fine', async () => 1)

    expect(sink.exited[0]?.fields?.['error']).toBeUndefined()
  })

  it('uses the injected clock and id generator', () => {
    let ticks = 0
    const trace = createTrace({ now: () => ++ticks, uid: () => `id-${++ticks}` })

    const sp = trace.span('op')
    expect(sp.id).toMatch(/^id-/)
    expect(sp.traceId).toMatch(/^id-/)
    expect(sp.timestamp).toBeGreaterThan(0)
  })

  it('supports `using` disposal', () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    {
      using sp = trace.span('scoped')
      expect(sp.id).not.toBe('')
    }

    expect(sink.exited).toHaveLength(1)
  })

  it('flush delegates to the installed layer', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    await expect(trace.flush()).resolves.toBeUndefined()
    expect(sink.flushes).toBe(1)

    // A layer with no flush is not an error.
    trace.install({})
    await expect(trace.flush()).resolves.toBeUndefined()
  })

  it('serializes without layer-private state', () => {
    const trace = createTrace({ layer: capture().layer })

    const sp = trace.span('op', Level.WARN, { a: 1 }, 'app:db')
    sp.end()

    expect(JSON.parse(JSON.stringify(sp))).toMatchObject({
      type: 'span',
      name: 'op',
      level: 'warn',
      target: 'app:db',
      traceId: sp.traceId,
      fields: { a: 1 },
    })
    expect(Object.keys(JSON.parse(JSON.stringify(sp)))).not.toContain('ext')
  })
})

describe('adoptSpan / linkSpan', () => {
  it('adoptSpan announces a foreign span and makes it current', () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    const sp = adoptSpan(trace, {
      type: 'span',
      id: 'foreign-1',
      traceId: 'trace-1',
      name: 'from-wasm',
      level: Level.INFO,
      timestamp: 1,
    })

    expect(sp).toBeDefined()
    expect(trace.current()).toBe(sp)
    expect(sink.entered.map((s) => s.name)).toEqual(['from-wasm'])

    // Descendants inherit the foreign trace id.
    expect(trace.span('local').traceId).toBe('trace-1')
  })

  it('adoptSpan honours the level filter', () => {
    const sink = capture(Level.INFO)
    const trace = createTrace({ layer: sink.layer })

    const sp = adoptSpan(trace, {
      type: 'span',
      id: 'x',
      traceId: 't',
      name: 'quiet',
      level: Level.DEBUG,
      timestamp: 1,
    })

    expect(sp).toBeUndefined()
    expect(sink.entered).toHaveLength(0)
  })

  it('linkSpan makes a span current without announcing it', () => {
    const sink = capture()
    const onEnter = vi.fn()
    const trace = createTrace({ layer: { ...sink.layer, onEnter } })

    const linked = linkSpan(trace, {
      type: 'span',
      id: 'remote-1',
      traceId: 'trace-9',
      name: 'caller',
      level: Level.INFO,
      timestamp: 1,
    })

    expect(onEnter).not.toHaveBeenCalled()
    expect(trace.current()).toBe(linked)

    const child = trace.span('local')
    expect(child.parentId).toBe('remote-1')
    expect(child.traceId).toBe('trace-9')
  })
})
