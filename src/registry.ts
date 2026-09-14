import type { Registry, Span } from './types.ts'

/** Options shared by the stack and ALS registries. */
export interface RegistryOptions {
  /** Depth cap; refuses further pushes past it. Default 1024. */
  maxDepth?: number
  /** Called with the refused span when a push would exceed `maxDepth`. */
  onOverflow?: (attempted: Span, depth: number) => void
}

/** The slice of `AsyncLocalStorage` this module uses. */
interface AsyncStore<T> {
  getStore(): T | undefined
  run<R>(store: T, fn: () => R): R
  enterWith(store: T): void
}
type AsyncStoreCtor = new <T>() => AsyncStore<T>

let cached: AsyncStoreCtor | null | undefined

/**
 * Resolve `AsyncLocalStorage` without a static `node:async_hooks` import.
 *
 * `process.getBuiltinModule` (Node >= 20.16 / 22.3, Deno >= 2.1, Bun) loads a
 * builtin synchronously from ESM, which is what lets one universal build pick
 * the right registry at runtime. That replaces the conditional-export split
 * this package used to carry: there is no `#registry` import map to keep in
 * sync across package.json and jsr.json, the source tree resolves without a
 * prior build, and bundlers need no `node:` externals config. `globalThis.process`
 * rather than a bare `process` keeps bundlers from injecting a shim.
 */
const asyncStore = (): AsyncStoreCtor | null => {
  if (cached !== undefined) return cached
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  const mod = proc?.getBuiltinModule?.('node:async_hooks') as { AsyncLocalStorage?: AsyncStoreCtor } | undefined
  return (cached = mod?.AsyncLocalStorage ?? null)
}

/** Whether an async-aware registry is available on this runtime. */
export const asyncSupported = (): boolean => asyncStore() !== null

/**
 * A single shared LIFO stack, bounded by `maxDepth`.
 *
 * Correct for synchronous code and for any runtime without async context, but
 * it cannot tell concurrent async tasks apart: two overlapping `scope` calls
 * interleave on one stack, so implicit parenting can attribute a span to the
 * wrong parent. Prefer {@link alsRegistry} wherever it is available.
 *
 * The depth bound turns an unclosed-span leak from silent unbounded growth
 * into a loud, findable condition. It does not fix the leak's cause.
 */
export const stackRegistry = (options: RegistryOptions = {}): Registry => {
  const maxDepth = options.maxDepth ?? 1024
  const onOverflow = options.onOverflow
  const stack: Span[] = []
  return {
    current: () => stack[stack.length - 1],
    push(span) {
      if (stack[stack.length - 1] === span) return
      if (stack.length >= maxDepth) {
        onOverflow?.(span, stack.length)
        return
      }
      stack.push(span)
    },
    remove(span) {
      const i = stack.lastIndexOf(span)
      if (i === -1) return false
      stack.splice(i, 1)
      return true
    },
    run(fn) {
      // The stack has no async scope to establish. Spans opened inside fn
      // push and pop themselves via push/end; run is a pass-through here.
      return fn()
    },
  }
}

/**
 * AsyncLocalStorage-backed {@link Registry}: the active-span chain is scoped
 * to an async execution rather than held in one process-global array.
 *
 * Why this removes the leak class: each logical task runs against its own
 * store. When the task settles, the runtime discards that store, so spans left
 * unclosed inside it become unreachable and are garbage collected — there is
 * no shared array for them to accumulate in. Concurrent tasks never see each
 * other's current span, so parenting stays correct under interleaving.
 *
 * The store is an immutable array: every push/remove swaps in a fresh copy via
 * `enterWith`. In-place mutation would be visible across async branches that
 * share the store reference (e.g. `Promise.all` siblings within one scope),
 * breaking isolation — do not "optimize" this to `.push`.
 *
 * `push`/`remove` use `enterWith`, which mutates the current async context
 * without a callback wrapper — matching the imperative shape `span()` needs.
 * A bare, never-ended span pushed outside any `run` scope can still outlive
 * its intended lifetime (there is no scope to discard it with); `scope()` is
 * the contained path.
 *
 * @throws if the runtime has no reachable `node:async_hooks`.
 */
export const alsRegistry = (options: RegistryOptions = {}): Registry => {
  const Ctor = asyncStore()
  if (!Ctor) throw new Error('[lickle/trace] alsRegistry requires node:async_hooks; use stackRegistry() instead')

  const maxDepth = options.maxDepth ?? 1024
  const onOverflow = options.onOverflow
  const als = new Ctor<readonly Span[]>()

  const stackOf = (): readonly Span[] => als.getStore() ?? []

  return {
    current: () => {
      const s = stackOf()
      return s[s.length - 1]
    },
    push(span) {
      const s = stackOf()
      if (s[s.length - 1] === span) return
      if (s.length >= maxDepth) {
        onOverflow?.(span, s.length)
        return
      }
      als.enterWith([...s, span])
    },
    remove(span) {
      const s = stackOf()
      const i = s.lastIndexOf(span)
      if (i === -1) return false
      als.enterWith([...s.slice(0, i), ...s.slice(i + 1)])
      return true
    },
    run(fn) {
      // Snapshot the current chain and run fn inside a fresh als.run scope.
      // Any enterWith push made by fn mutates only this scope's store, which
      // the runtime discards when fn settles — so unclosed spans can't leak up.
      return als.run([...stackOf()], fn)
    },
  }
}

/**
 * The registry `createTrace` uses when none is injected: async-aware where the
 * runtime supports it, otherwise the shared stack.
 */
export const registry = (options: RegistryOptions = {}): Registry =>
  asyncSupported() ? alsRegistry(options) : stackRegistry(options)
