import { describe, expect, it } from 'vitest'

import { extract, inject, linkRemote, spanIdOf, traceIdOf, withRemoteParent } from './propagate.ts'
import { createTrace } from './trace.ts'
import { capture } from './test.ts'
import { Level } from './types.ts'

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/

describe('inject', () => {
  it('writes a well-formed traceparent from the active span', () => {
    const trace = createTrace({ layer: capture().layer })
    const carrier: Record<string, string> = {}

    trace.scope('call', () => inject(trace.current(), carrier))

    expect(carrier['traceparent']).toMatch(TRACEPARENT)
  })

  it('writes nothing when there is no span, or the span is filtered out', () => {
    const trace = createTrace({ layer: capture(Level.INFO).layer })
    const carrier: Record<string, string> = {}

    inject(undefined, carrier)
    inject(trace.span('quiet', Level.DEBUG), carrier)

    expect(carrier['traceparent']).toBeUndefined()
  })

  it('works with a Headers-style carrier', () => {
    const trace = createTrace({ layer: capture().layer })
    const headers = new Headers()

    inject(trace.span('call'), headers)

    expect(headers.get('traceparent')).toMatch(TRACEPARENT)
  })
})

describe('extract', () => {
  it('parses a valid traceparent and reads the sampled flag', () => {
    const traceId = 'a'.repeat(32)
    const parentId = 'b'.repeat(16)

    expect(extract({ traceparent: `00-${traceId}-${parentId}-01` })).toEqual({ traceId, parentId, sampled: true })
    expect(extract({ traceparent: `00-${traceId}-${parentId}-00` })?.sampled).toBe(false)
  })

  it('rejects malformed, absent, and unsupported-version headers', () => {
    expect(extract({})).toBeUndefined()
    expect(extract({ traceparent: 'garbage' })).toBeUndefined()
    expect(extract({ traceparent: `01-${'a'.repeat(32)}-${'b'.repeat(16)}-01` })).toBeUndefined()
    expect(extract({ traceparent: `00-${'a'.repeat(31)}-${'b'.repeat(16)}-01` })).toBeUndefined()
  })
})

describe('id translation', () => {
  it('is deterministic and idempotent, so a trace survives repeated hops', () => {
    const trace = createTrace({ layer: capture().layer })
    const sp = trace.span('op')

    expect(traceIdOf(sp)).toHaveLength(32)
    expect(spanIdOf(sp)).toHaveLength(16)
    expect(traceIdOf(sp)).toBe(traceIdOf(sp))

    // A span whose traceId already arrived over the wire is passed through
    // unchanged — otherwise each hop would re-hash and split the trace.
    const wire = 'c'.repeat(32)
    const linked = linkRemote(trace, { traceparent: `00-${wire}-${'d'.repeat(16)}-01` })!
    const local = linked.child('local')
    expect(traceIdOf(local)).toBe(wire)
  })
})

describe('withRemoteParent', () => {
  it('joins the caller trace and parents onto the caller span', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    const traceId = 'e'.repeat(32)
    const parentId = 'f'.repeat(16)
    const carrier = { traceparent: `00-${traceId}-${parentId}-01` }

    await withRemoteParent(trace, carrier, 'GET /users', async () => {
      trace.event('handling', Level.INFO)
    })

    const local = sink.entered[0]!
    expect(local.name).toBe('GET /users')
    expect(local.traceId).toBe(traceId)
    expect(local.parentId).toBe(parentId)
    expect(sink.events[0]?.traceId).toBe(traceId)
  })

  it('does not re-report the caller span the caller already exported', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    await withRemoteParent(trace, { traceparent: `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01` }, 'op', async () => {})

    expect(sink.names()).toEqual(['op'])
    expect(sink.exited.map((s) => s.name)).toEqual(['op'])
  })

  it('starts a fresh trace when the caller sent no traceparent', async () => {
    const sink = capture()
    const trace = createTrace({ layer: sink.layer })

    await withRemoteParent(trace, {}, 'op', async () => {})

    expect(sink.entered[0]?.parentId).toBeUndefined()
    expect(sink.entered[0]?.traceId).toBeTruthy()
  })

  it('releases the remote link on return, throw, and rejection', async () => {
    const trace = createTrace({ layer: capture().layer })
    const carrier = { traceparent: `00-${'e'.repeat(32)}-${'f'.repeat(16)}-01` }

    withRemoteParent(trace, carrier, 'sync', () => {})
    expect(trace.current()).toBeUndefined()

    expect(() =>
      withRemoteParent(trace, carrier, 'throws', () => {
        throw new Error('nope')
      }),
    ).toThrow('nope')
    expect(trace.current()).toBeUndefined()

    await expect(
      withRemoteParent(trace, carrier, 'rejects', async () => {
        throw new Error('async nope')
      }),
    ).rejects.toThrow('async nope')
    expect(trace.current()).toBeUndefined()
  })

  it('round-trips: what a callee injects rejoins what the caller sent', async () => {
    const trace = createTrace({ layer: capture().layer })
    const first: Record<string, string> = {}

    // Service A opens a root span and calls out.
    trace.scope('a', () => inject(trace.current(), first))

    // Service B continues it and calls on to service C.
    const second: Record<string, string> = {}
    await withRemoteParent(trace, first, 'b', async () => {
      inject(trace.current(), second)
    })

    expect(extract(second)?.traceId).toBe(extract(first)?.traceId)
  })
})
