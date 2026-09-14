import type { Fields, Level } from '../types.ts'

/** Writes one formatted line. Swap it to redirect output to any sink. */
export type PrintFn = (level: Level, message: string, fields?: Fields) => void

/**
 * Print to the console method matching the level.
 *
 * No level -> method table is needed: {@link Level}'s string values are
 * exactly `console`'s method names. This replaces the three byte-identical
 * node / browser / universal copies this module used to ship behind an
 * export-conditions map that nothing ever imported.
 */
export const print: PrintFn = (level, message, fields) => {
  if (fields) console?.[level](message, fields)
  else console?.[level](message)
}
