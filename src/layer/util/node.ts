import type { PrintFn } from '../console.ts'
import { levels } from './universal.ts'

export const print: PrintFn = (level, message, fields) => {
  const method = levels[level]
  if (fields) console?.[method](message, fields)
  else console?.[method](message)
}
