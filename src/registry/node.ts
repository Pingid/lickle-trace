import { AsyncLocalStorage } from 'node:async_hooks'

import type { Span, Registry } from '../types.ts'
import type { RegistryOptions } from './universal.ts'

export { stackRegistry, type RegistryOptions } from './universal.ts'

/**
 * AsyncLocalStorage-backed {@link Registry}: the active-span chain is scoped
 * to an async execution rather than held in one process-global array.
 *
 * Why this removes the leak class: each logical task runs against its own
 * store. When the task settles, Node discards that store, so spans left
 * unclosed inside it become unreachable and are garbage collected — there is
 * no shared array for them to accumulate in. Concurrent tasks never see each
 * other's current span, so parenting stays correct under interleaving.
 *
 * The store is a frozen-in-practice immutable array: every push/remove swaps
 * in a fresh copy via `enterWith`. In-place mutation would be visible across
 * async branches that share the store reference (e.g. `Promise.all` siblings
 * within one scope), breaking isolation — do not "optimize" this to `.push`.
 *
 * `push`/`remove` use `enterWith`, which mutates the current async context
 * without a callback wrapper — matching the imperative shape `span()` needs.
 * A bare, never-ended span pushed outside any `run` scope can still outlive
 * its intended lifetime (there is no scope to discard it with); `scope()` is
 * the contained path.
 *
 * @example
 * ```ts
 * import { createTrace, alsRegistry } from '@lickle/trace'
 * export const trace = createTrace({ spans: alsRegistry() })
 * ```
 */
export const alsRegistry = (options: RegistryOptions = {}): Registry => {
  const maxDepth = options.maxDepth ?? 1024
  const onOverflow = options.onOverflow
  const als = new AsyncLocalStorage<readonly Span[]>()

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
      // Node discards when fn settles — so unclosed spans cannot leak upward.
      return als.run([...stackOf()], fn)
    },
  }
}

/** The default registry for this entrypoint (node: AsyncLocalStorage). */
export const registry = (options: RegistryOptions = {}): Registry => alsRegistry(options)
