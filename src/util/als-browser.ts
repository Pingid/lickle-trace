export interface AlsLike<T> {
  getStore(): T | undefined
  enterWith(value: T): void
  run<R>(value: T, fn: () => R): R
  wrap<F extends (...a: any[]) => any>(fn: F): F
}

export class BrowserALS<T> implements AlsLike<T> {
  private current: T | undefined
  getStore() {
    return this.current
  }
  enterWith(value: T) {
    this.current = value
  }
  run<R>(value: T, fn: () => R): R {
    const prev = this.current
    this.current = value
    try {
      return fn()
    } finally {
      this.current = prev
    }
  }
  wrap<F extends (...a: any[]) => any>(fn: F): F {
    const store = this.current
    const self = this
    return function wrapped(this: any, ...args: any[]) {
      const prev = self.current
      self.current = store
      try {
        return fn.apply(this, args)
      } finally {
        self.current = prev
      }
    } as F
  }
}

// Global patch installer (idempotent)
export function installBrowserALS<T = unknown>(): AlsLike<T> {
  const g: any = typeof window !== 'undefined' ? window : globalThis
  const k = '__als_instance__'
  const als: BrowserALS<any> = g[k] ?? (g[k] = new BrowserALS())
  if (typeof window === 'undefined') return als as AlsLike<T>

  // --- Promise.then/catch/finally ---
  const P = Promise.prototype as any
  if (!P.__als_patched) {
    const origThen = P.then,
      origCatch = P.catch,
      origFinally = P.finally
    P.then = function (onFulfilled?: any, onRejected?: any) {
      return origThen.call(
        this,
        typeof onFulfilled === 'function' ? als.wrap(onFulfilled) : onFulfilled,
        typeof onRejected === 'function' ? als.wrap(onRejected) : onRejected,
      )
    }
    P.catch = function (onRejected?: any) {
      return origCatch.call(this, typeof onRejected === 'function' ? als.wrap(onRejected) : onRejected)
    }
    P.finally = function (onFinally?: any) {
      return origFinally.call(this, typeof onFinally === 'function' ? als.wrap(onFinally) : onFinally)
    }
    P.__als_patched = true
  }

  // --- queueMicrotask ---
  if (typeof queueMicrotask === 'function' && !(queueMicrotask as any).__als_patched) {
    const origQ = queueMicrotask
    ;(window as any).queueMicrotask = (cb: VoidFunction) => origQ(als.wrap(cb as any) as any)
    ;(queueMicrotask as any).__als_patched = true
  }

  // --- setTimeout/setInterval ---
  const t = window.setTimeout as any
  if (!t.__als_patched) {
    const oSetTimeout = window.setTimeout,
      oSetInterval = window.setInterval
    window.setTimeout = ((cb: TimerHandler, delay?: number, ...args: any[]) =>
      oSetTimeout(typeof cb === 'function' ? (als.wrap(cb as any) as any) : cb, delay as any, ...args)) as any
    window.setInterval = ((cb: TimerHandler, delay?: number, ...args: any[]) =>
      oSetInterval(typeof cb === 'function' ? (als.wrap(cb as any) as any) : cb, delay as any, ...args)) as any
    t.__als_patched = true
  }

  // --- requestAnimationFrame (window & workers that have it) ---
  const raf = (window as any).requestAnimationFrame
  if (typeof raf === 'function' && !raf.__als_patched) {
    const oRAF = raf.bind(window)
    ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => oRAF(als.wrap(cb))
    raf.__als_patched = true
  }

  // --- addEventListener / removeEventListener ---
  const proto = (window as any).EventTarget?.prototype
  if (proto && !proto.__als_patched) {
    const oAdd = proto.addEventListener,
      oRem = proto.removeEventListener
    const map = new WeakMap<Function, Function>()
    proto.addEventListener = function (type: any, listener: any, options?: any) {
      const wrapped = typeof listener === 'function' ? (map.get(listener) ?? als.wrap(listener)) : listener
      if (typeof listener === 'function' && !map.has(listener)) map.set(listener, wrapped)
      return oAdd.call(this, type, wrapped, options)
    }
    proto.removeEventListener = function (type: any, listener: any, options?: any) {
      const wrapped = typeof listener === 'function' ? (map.get(listener) ?? listener) : listener
      return oRem.call(this, type, wrapped, options)
    }
    proto.__als_patched = true
  }

  return als as AlsLike<T>
}
