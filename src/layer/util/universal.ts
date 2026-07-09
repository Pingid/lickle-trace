import type { PrintFn } from '../console.ts'
import { Level } from '../../types.ts'

/** Maps log levels to their console method names. */
export const levels = {
  [Level.TRACE]: 'trace',
  [Level.DEBUG]: 'debug',
  [Level.INFO]: 'info',
  [Level.WARN]: 'warn',
  [Level.ERROR]: 'error',
} as const

export const print: PrintFn = (level, message, fields) => {
  const method = levels[level]
  if (fields) console?.[method](message, fields)
  else console?.[method](message)
}
