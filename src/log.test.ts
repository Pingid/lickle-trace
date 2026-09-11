import { describe, expect, it } from 'vitest'

import { Level } from './types.ts'
import { createTrace } from './trace.ts'
import { createLog } from './log.ts'
import { capture } from './test.ts'

const setup = () => {
  const sink = capture()
  const trace = createTrace({ layer: sink.layer })
  return { log: createLog(trace), trace, sink }
}

describe('Logger', () => {
  it('logs template literals, primitives, null, and errors', () => {
    const { log, sink } = setup()

    log.info`hello ${'world'}`
    log.warn('plain')
    log.debug(null)
    log.error(new Error('boom'))

    expect(sink.messages()).toEqual(['hello world', 'plain', 'null', 'boom'])
    expect(sink.events[3]?.fields).toMatchObject({ name: 'Error' })
    expect(sink.events[3]?.level).toBe(Level.ERROR)
  })

  it('merges metadata fields into events', () => {
    const { log, sink } = setup()

    log.with({ app: 'test' }).info({ requestId: 'r-1' })`with meta`

    expect(sink.events[0]?.fields).toMatchObject({ app: 'test', requestId: 'r-1' })
  })

  it('emits directly when a message accompanies metadata', () => {
    const { log, sink } = setup()

    log.info({ requestId: 'r-1' }, 'direct')

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.message).toBe('direct')
    expect(sink.events[0]?.fields).toMatchObject({ requestId: 'r-1' })
  })

  it('a bare metadata call emits nothing until the returned function is called', () => {
    const { log, sink } = setup()

    const carried = log.info({ requestId: 'r-1' })
    expect(sink.events).toHaveLength(0)

    carried('now')
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.fields).toMatchObject({ requestId: 'r-1' })
  })

  it('derives loggers whose fields compose', () => {
    const { log, sink } = setup()

    log.with({ a: 1 }).with({ b: 2 }).info('hi')

    expect(sink.events[0]?.fields).toMatchObject({ a: 1, b: 2 })
  })

  it('stamps a target on events and spans, and keeps fields across the derivation', () => {
    const { log, sink } = setup()

    const db = log.with({ pool: 'main' }).target('app:db')
    db.info('connected')
    db.span('query', () => {})

    expect(db.targetName).toBe('app:db')
    expect(sink.events[0]?.target).toBe('app:db')
    expect(sink.events[0]?.fields).toMatchObject({ pool: 'main' })
    expect(sink.entered[0]?.target).toBe('app:db')

    // The original is untouched.
    log.info('plain')
    expect(sink.events[1]?.target).toBeUndefined()
  })

  it('creates spans at INFO by default and at the variant level', async () => {
    const { log, sink } = setup()

    log.span('default-level', () => {})
    await log.span.debug('debug-level', { detail: 1 }, async () => {})
    const handle = log.span.warn('handle')
    handle.end()

    expect(sink.entered.map((s) => s.level)).toEqual([Level.INFO, Level.DEBUG, Level.WARN])
    expect(sink.exited).toHaveLength(3)
    expect(sink.entered[1]?.fields).toMatchObject({ detail: 1 })
  })

  it('span callbacks receive the span and end it on throw', () => {
    const { log, sink } = setup()

    expect(() =>
      log.span('boom', (sp) => {
        sp.setFields({ step: 'before-throw' })
        throw new Error('nope')
      }),
    ).toThrow('nope')

    expect(sink.exited).toHaveLength(1)
    expect(sink.exited[0]?.fields).toMatchObject({ step: 'before-throw' })
    expect(sink.exited[0]?.fields?.['error']).toMatchObject({ message: 'nope' })
  })

  it('instrument spans every call and preserves arguments and return values', async () => {
    const { log, sink } = setup()

    const add = log.instrument('add', (a: number, b: number) => a + b)
    expect(add(2, 3)).toBe(5)
    expect(add(4, 5)).toBe(9)

    const load = log.instrument('load', async (id: string) => `row:${id}`, {
      level: Level.DEBUG,
      fields: { table: 'users' },
    })
    await expect(load('u-1')).resolves.toBe('row:u-1')

    expect(sink.names()).toEqual(['add', 'add', 'load'])
    expect(sink.entered[2]?.level).toBe(Level.DEBUG)
    expect(sink.entered[2]?.fields).toMatchObject({ table: 'users' })
    expect(sink.exited).toHaveLength(3)
  })

  it('instrument records a rejection and rethrows it', async () => {
    const { log, sink } = setup()

    const fail = log.instrument('fail', async () => {
      throw new Error('down')
    })

    await expect(fail()).rejects.toThrow('down')
    expect(sink.exited[0]?.fields?.['error']).toMatchObject({ message: 'down' })
  })
})
