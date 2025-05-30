export const uuid = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)

export const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
