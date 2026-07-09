import { describe, expect, it } from 'vitest'

import { alsRegistry } from './node.ts'
import { createTrace } from '../trace.ts'
import { createLog } from '../log.ts'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
    expect(trace.current()).toBeUndefined()
  })

  it('confines spans opened inside runNew to the scope', async () => {
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
})
