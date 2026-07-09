import type { Span, Registry } from '../types.ts'

/** Options shared by the stack and ALS registries. */
export interface RegistryOptions {
  /** Depth cap; refuses further pushes past it. Default 1024. */
  maxDepth?: number
  /** Called with the refused span when a push would exceed `maxDepth`. */
  onOverflow?: (attempted: Span, depth: number) => void
}

/**
 * Default registry: a single shared LIFO stack, bounded by `maxDepth`.
 *
 * The bound turns an unclosed-span leak from silent unbounded growth into a
 * loud, findable condition. It does not fix the leak's cause — for that on
 * Node, use `alsRegistry`, where a finished task's store is discarded by the
 * runtime and there is no shared array to accumulate into.
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

/** The default registry for this entrypoint (universal: shared stack). */
export const registry = (options: RegistryOptions = {}): Registry => stackRegistry(options)
