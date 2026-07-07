export * from './filter.js'

type AlsLike<T> = { getStore(): T | undefined; enterWith(value: T): void }

export const Utils = {
  ALS: undefined as AlsLike<any> | undefined,
  now: () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.timeOrigin + performance.now()
      : Date.now(),
  uuid: () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
}

/** Capture simple source location info from a stack trace. */
export const source = () => {
  let file: string | undefined
  let line: number | undefined
  let target: string | undefined
  try {
    const e = new Error()
    const s = (e.stack || '').split('\n').slice(2).find(Boolean)
    if (s) {
      const m = s.match(/\(?([^():]+):(\d+):(\d+)\)?$/)
      if (m && m[1]) {
        const ff = m[1]
        file = ff
        line = Number(m[2])
        const parts = ff.split(/[\\/]/)
        const last = parts[parts.length - 1] || ''
        target = last.replace(/\.[^/.]+$/, '')
      }
    }
  } catch {}
  return { file, line, target }
}
