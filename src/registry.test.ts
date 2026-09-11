import { describe, expect, it } from 'vitest'

import { alsRegistry, asyncSupported, registry, stackRegistry } from './registry.ts'
import { createTrace } from './trace.ts'
import { createLog } from './log.ts'
import { Level } from './types.ts'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('registry selection', () => {
  it('picks the async-aware registry on this runtime', () => {
    // Node reaches `node:async_hooks` through `process.getBuiltinModule`, with
    // no conditional export or import map involved.
    expect(asyncSupported()).toBe(true)

    const trace = createTrace({ spans: registry() })
    expect(trace.current()).toBeUndefined()
  })
})

describe('stackRegistry', () => {
  it('tracks the current span and removes out of order', () => {
    const trace = createTrace({ spans: stackRegistry() })

    const a = trace.span('a')
    const b = trace.span('b')
    expect(trace.current()).toBe(b)

    a.end() // out of order — b is still on top
    expect(trace.current()).toBe(b)
    b.end()
    expect(trace.current()).toBeUndefined()
  })

  it('refuses pushes past maxDepth and reports them', () => {
    const refused: string[] = []
    const trace = createTrace({
      spans: stackRegistry({ maxDepth: 2, onOverflow: (span) => void refused.push(span.name) }),
    })

    trace.span('a')
    trace.span('b')
    trace.span('c')

    expect(refused).toEqual(['c'])
  })
})

describe('alsRegistry', () => {
  it("keeps concurrent scopes' parenting isolated", async () => {
    const trace = createTrace({ spans: alsRegistry() })

    const run = (name: string) =>
      trace.scope(name, async (sp) => {
        await tick()
        // After the await, the scope's own span must still be current.
        expect(trace.current()?.id).toBe(sp.id)
        return sp
      })

    const [a, b] = await Promise.all([run('a'), run('b')])

    expect(a.id).not.toBe(b.id)
    expect(a.traceId).not.toBe(b.traceId)
    expect(trace.current()).toBeUndefined()
  })

  it('confines spans opened inside a scope', async () => {
    const trace = createTrace({ spans: alsRegistry() })

    await trace.scope('outer', async () => {
      trace.span('leaked-but-contained') // never ended on purpose
      await tick()
    })

    expect(trace.current()).toBeUndefined()
  })

  it("Logger.span's callback form is ALS-contained", async () => {
    const trace = createTrace({ spans: alsRegistry() })
    const log = createLog(trace)

    // Concurrent logger spans must not see each other as parents...
    const run = (name: string) =>
      log.span(name, async () => {
        await tick()
        expect(trace.current()?.name).toBe(name)
        return trace.current()!
      })
    const [a, b] = await Promise.all([run('a'), run('b')])
    expect(a.id).not.toBe(b.id)
    expect(a.parentId).toBeUndefined()
    expect(b.parentId).toBeUndefined()

    // ...and spans opened (and never ended) inside the callback stay confined.
    await log.span('outer', async () => {
      trace.span('unclosed')
      await tick()
    })
    expect(trace.current()).toBeUndefined()
  })

  it('carries one traceId across an await boundary', async () => {
    const trace = createTrace({ spans: alsRegistry() })

    const seen = await trace.scope('root', async (root) => {
      await tick()
      const child = trace.span('child', Level.DEBUG)
      child.end()
      return [root.traceId, child.traceId]
    })

    expect(seen[0]).toBe(seen[1])
  })
})
