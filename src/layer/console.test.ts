import { describe, expect, it } from 'vitest'

import * as Console from './console.ts'
import { createTrace } from '../trace.ts'
import { Level, type Fields } from '../types.ts'

const sink = () => {
  const lines: [Level, string, Fields | undefined][] = []
  return { lines, print: (level: Level, message: string, fields?: Fields) => void lines.push([level, message, fields]) }
}

describe('Console.layer', () => {
  it('prints enter and exit with a duration, at the span level', () => {
    const out = sink()
    let clock = 1000
    const trace = createTrace({ layer: Console.layer({ print: out.print }), now: () => (clock += 20) })

    trace.scope('work', () => {}, Level.WARN, { path: '/users' })

    expect(out.lines[0]).toEqual([Level.WARN, 'enter -> (work)', { path: '/users' }])
    expect(out.lines[1]?.[0]).toBe(Level.WARN)
    expect(out.lines[1]?.[1]).toMatch(/^exit <- \(work\) \d+\.\d{2}ms$/)
  })

  it('measures the duration from the recorded endTimestamp', () => {
    const out = sink()
    let clock = 0
    const trace = createTrace({ layer: Console.layer({ print: out.print }), now: () => (clock += 10) })

    trace.span('op').end() // timestamp 10, endTimestamp 20

    expect(out.lines[1]?.[1]).toBe('exit <- (op) 10.00ms')
  })

  it('prefixes the target when there is one', () => {
    const out = sink()
    const trace = createTrace({ layer: Console.layer({ print: out.print }) })

    trace.event('connected', Level.INFO, {}, 'app:db')

    expect(out.lines[0]?.[1]).toBe('app:db connected')
    expect(out.lines[0]?.[2]).toBeUndefined() // no trailing empty `{}`
  })

  it('emits one complete NDJSON record per span and event', () => {
    const out = sink()
    const trace = createTrace({ layer: Console.layer({ format: Console.json, print: out.print }) })

    trace.scope('work', () => trace.event('inside', Level.INFO), Level.INFO, { a: 1 })

    // No line for `enter` — the span is reported once, on exit.
    expect(out.lines).toHaveLength(2)

    const event = JSON.parse(out.lines[0]![1]) as Record<string, unknown>
    const span = JSON.parse(out.lines[1]![1]) as Record<string, unknown>

    expect(event).toMatchObject({ type: 'event', message: 'inside', level: 'info' })
    expect(span).toMatchObject({ type: 'span', name: 'work', level: 'info', fields: { a: 1 } })
    expect(span['endTimestamp']).toBeGreaterThan(span['timestamp'] as number)
    expect(event['traceId']).toBe(span['traceId'])
    expect(out.lines.every(([, , fields]) => fields === undefined)).toBe(true)
  })
})
