// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { BrowserALS, installBrowserALS } from './als-browser.js'

describe('BrowserALS', () => {
  it('basic store, enterWith, run, wrap semantics', () => {
    const als = new BrowserALS<number>()
    expect(als.getStore()).toBeUndefined()

    als.enterWith(1)
    expect(als.getStore()).toBe(1)

    const res = als.run(2, () => {
      expect(als.getStore()).toBe(2)
      return 'ok'
    })
    expect(res).toBe('ok')
    expect(als.getStore()).toBe(1)

    als.enterWith(99)
    const fn = () => als.getStore()
    const wrapped = als.wrap(fn)
    als.enterWith(123)
    expect(wrapped()).toBe(99)
    expect(als.getStore()).toBe(123)
  })
})

describe('installBrowserALS - global patches and propagation', () => {
  beforeEach(() => {
    // Ensure a window exists and create a fresh raf for tests that need it later
    if (!(window as any).requestAnimationFrame) {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
        return setTimeout(() => cb(performance.now()), 0) as unknown as number
      }
    }
  })

  it('propagates through Promise.then/catch/finally', async () => {
    const als = installBrowserALS<number>()
    als.enterWith(7)

    const a = await Promise.resolve(0).then(() => als.getStore())
    expect(a).toBe(7)

    const b = await Promise.reject(0).catch(() => als.getStore())
    expect(b).toBe(7)

    let f: number | undefined
    await Promise.resolve().finally(() => {
      f = als.getStore()
    })
    expect(f).toBe(7)
  })

  it('propagates through queueMicrotask', async () => {
    const als = installBrowserALS<number>()
    als.enterWith(11)
    let s: number | undefined
    await new Promise<void>((r) => {
      queueMicrotask(() => {
        s = als.getStore()
        r()
      })
    })
    expect(s).toBe(11)
  })

  it('propagates through setTimeout', async () => {
    const als = installBrowserALS<number>()
    als.enterWith(21)
    let s: number | undefined
    await new Promise<void>((r) => {
      setTimeout(() => {
        s = als.getStore()
        r()
      }, 0)
    })
    expect(s).toBe(21)
  })

  it('propagates through setInterval and supports remove', async () => {
    const als = installBrowserALS<number>()
    als.enterWith(31)
    let s: number | undefined
    await new Promise<void>((r) => {
      const id = setInterval(() => {
        s = als.getStore()
        clearInterval(id)
        r()
      }, 0)
    })
    expect(s).toBe(31)
  })

  it('propagates through requestAnimationFrame', async () => {
    const als = installBrowserALS<number>()
    als.enterWith(41)
    let s: number | undefined
    await new Promise<void>((r) => {
      ;(window as any).requestAnimationFrame((t: number) => {
        void t
        s = als.getStore()
        r()
      })
    })
    expect(s).toBe(41)
  })

  it('wraps addEventListener handlers and supports removeEventListener', async () => {
    const als = installBrowserALS<number>()
    const target = new EventTarget()
    als.enterWith(51)

    let seen: number | undefined
    const h = () => {
      seen = als.getStore()
    }
    target.addEventListener('x', h)

    // Change current store; handler should see the one from registration time
    als.enterWith(99)
    target.dispatchEvent(new Event('x'))
    expect(seen).toBe(51)

    // Remove should work with original handler reference
    seen = undefined
    target.removeEventListener('x', h)
    target.dispatchEvent(new Event('x'))
    expect(seen).toBeUndefined()
  })

  it('is idempotent when installed multiple times', () => {
    installBrowserALS()
    const mid = Promise.prototype.then
    installBrowserALS()
    const post = Promise.prototype.then
    expect(post).toBe(mid)
  })
})
