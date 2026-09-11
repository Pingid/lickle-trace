import { describe, expect, it } from 'vitest'

import { createIngest } from './ingest.ts'
import { createTrace } from './trace.ts'
import { capture } from './test.ts'
import { Level, type SpanBase } from './types.ts'

const span = (id: string, name: string, extra: Partial<SpanBase> = {}): SpanBase => ({
  type: 'span',
  id,
  traceId: 'wire-trace',
  name,
  level: Level.INFO,
  timestamp: 1,
  ...extra,
})

describe('createIngest', () => {
  it('hydrates a foreign span once and retires it on exit', () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })
    const ingest = createIngest(trace)

    ingest.enter(span('s1', 'foreign'))
    ingest.enter(span('s1', 'foreign')) // idempotent re-entry
    expect(sink.names()).toEqual(['foreign'])

    ingest.exit(span('s1', 'foreign'))
    ingest.exit(span('s1', 'foreign')) // idempotent
    expect(sink.exited).toHaveLength(1)
    expect(trace.current()).toBeUndefined()
  })

  it('resolves parents against the in-flight index', () => {
    const sink = capture()
    const ingest = createIngest(createTrace({ layer: sink.layer }))

    ingest.enter(span('s1', 'parent'))
    ingest.enter(span('s2', 'child', { parentId: 's1' }))

    expect(sink.entered[1]?.parent).toBe(sink.entered[0])
    expect(sink.entered[1]?.parentId).toBe('s1')
  })

  it('preserves the foreign traceId on spans and events', () => {
    const sink = capture()
    const ingest = createIngest(createTrace({ layer: sink.layer }))

    ingest.enter(span('s1', 'parent'))
    ingest.event({
      type: 'event',
      id: 'e1',
      traceId: 'wire-trace',
      level: Level.INFO,
      timestamp: 2,
      parentId: 's1',
      message: 'hi',
    })

    expect(sink.entered[0]?.traceId).toBe('wire-trace')
    expect(sink.events[0]?.traceId).toBe('wire-trace')
    expect(sink.events[0]?.parent).toBe(sink.entered[0])
  })

  it('leaves parent undefined once the parent has exited, keeping parentId', () => {
    const sink = capture()
    const ingest = createIngest(createTrace({ layer: sink.layer }))

    ingest.enter(span('s1', 'parent'))
    ingest.exit(span('s1', 'parent'))
    ingest.event({ type: 'event', id: 'e1', traceId: 'wire-trace', level: Level.INFO, timestamp: 3, parentId: 's1' })

    expect(sink.events[0]?.parent).toBeUndefined()
    expect(sink.events[0]?.parentId).toBe('s1')
  })

  it('drops spans and events below the layer floor', () => {
    const sink = capture(Level.INFO)
    const ingest = createIngest(createTrace({ layer: sink.layer }))

    ingest.enter(span('s1', 'quiet', { level: Level.DEBUG }))
    ingest.exit(span('s1', 'quiet', { level: Level.DEBUG }))
    ingest.event({ type: 'event', id: 'e1', traceId: 'wire-trace', level: Level.DEBUG, timestamp: 4 })

    expect(sink.entered).toHaveLength(0)
    expect(sink.exited).toHaveLength(0)
    expect(sink.events).toHaveLength(0)
  })
})
