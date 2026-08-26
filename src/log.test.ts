import { describe, expect, it } from 'vitest'

import { Level, type Event, type Layer, type Span } from './types.ts'
import { createTrace } from './trace.ts'
import { createLog, hook } from './log.ts'

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

describe('Logger', () => {
  const setup = () => {
    const { layer, entered, exited, events } = collect()
    const trace = createTrace({ layer })
    return { log: createLog(trace), entered, exited, events }
  }

  it('logs template literals, primitives, null, and errors', () => {
    const { log, events } = setup()

    log.info`hello ${'world'}`
    log.warn('plain')
    log.debug(null)
    log.error(new Error('boom'))

    expect(events.map((e) => e.message)).toEqual(['hello world', 'plain', 'null', 'boom'])
    expect(events[3]?.fields).toMatchObject({ name: 'Error' })
    expect(events[3]?.level).toBe(Level.ERROR)
  })

  it('merges metadata fields into events', () => {
    const { log, events } = setup()

    log.with({ app: 'test' }).info({ requestId: 'r-1' })`with meta`

    expect(events[0]?.fields).toMatchObject({ app: 'test', requestId: 'r-1' })
  })

  it('emits directly when a message accompanies metadata', () => {
    const { log, events } = setup()

    log.info({ requestId: 'r-1' }, 'direct')

    expect(events).toHaveLength(1)
    expect(events[0]?.message).toBe('direct')
    expect(events[0]?.fields).toMatchObject({ requestId: 'r-1' })
  })

  it('a bare metadata call emits nothing until the returned function is called', () => {
    const { log, events } = setup()

    const carried = log.info({ requestId: 'r-1' })
    expect(events).toHaveLength(0)

    carried('now')
    expect(events).toHaveLength(1)
    expect(events[0]?.fields).toMatchObject({ requestId: 'r-1' })
  })

  it('derives loggers whose fields compose', () => {
    const { log, events } = setup()

    log.with({ a: 1 }).with({ b: 2 }).info('hi')

    expect(events[0]?.fields).toMatchObject({ a: 1, b: 2 })
  })

  it('carries nothing but the call-site fields when it has no hooks', () => {
    const { log, events } = setup()

    log.info('bare')

    expect(events[0]?.fields).toEqual({})
  })

  it('resolves conflicts in favour of the later derivation, then the call site', () => {
    const { log, events } = setup()

    log.with({ k: 'first' }).with({ k: 'second' }).info('later wins')
    log.with({ k: 'first' }).info({ k: 'call-site' }, 'call site wins')

    expect(events[0]?.fields).toMatchObject({ k: 'second' })
    expect(events[1]?.fields).toMatchObject({ k: 'call-site' })
  })

  it('hooks contribute fields and extra members, and hold their own state', () => {
    const { log, events } = setup()

    const counter = hook(() => {
      let n = 0
      return { fields: (fields) => ({ ...fields, seq: ++n }), ext: { count: () => n } }
    })

    const counted = log.with(counter)
    counted.info('one')
    counted.info('two')

    expect(events.map((e) => e.fields?.['seq'])).toEqual([1, 2])
    expect(counted.count()).toBe(2)
  })

  it('gives hooks the log they are attached to and its trace', () => {
    const { layer } = collect()
    const trace = createTrace({ layer })
    let seen: { self?: unknown; trace?: unknown } = {}

    const spy = hook((self, t) => ((seen = { self, trace: t }), {}))
    const log = createLog(trace, spy)

    expect(seen.self).toBe(log)
    expect(seen.trace).toBe(trace)
  })

  it('composes hooks with fields sugar in either order', () => {
    const { log, events } = setup()

    const stamp = hook(() => ({ fields: (fields) => ({ ...fields, stamped: true }) }))

    log.with(stamp).with({ service: 'api' }).info('a')
    log.with({ service: 'api' }).with(stamp).info('b')

    expect(events[0]?.fields).toMatchObject({ stamped: true, service: 'api' })
    expect(events[1]?.fields).toMatchObject({ stamped: true, service: 'api' })
  })

  it('creates spans at INFO by default and at the variant level', async () => {
    const { log, entered, exited } = setup()

    log.span('default-level', () => {})
    await log.span.debug('debug-level', { detail: 1 }, async () => {})
    const handle = log.span.warn('handle')
    handle.end()

    expect(entered.map((s) => s.level)).toEqual([Level.INFO, Level.DEBUG, Level.WARN])
    expect(exited).toHaveLength(3)
    expect(entered[1]?.fields).toMatchObject({ detail: 1 })
  })

  it('span callbacks receive the span and end it on throw', () => {
    const { log, exited } = setup()

    expect(() =>
      log.span('boom', (sp) => {
        sp.setFields({ step: 'before-throw' })
        throw new Error('nope')
      }),
    ).toThrow('nope')

    expect(exited).toHaveLength(1)
    expect(exited[0]?.fields).toMatchObject({ step: 'before-throw' })
  })
})
