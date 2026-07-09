import { Level, type Layer } from './types.ts'

// `Symbol.dispose` may be absent on older runtimes (some wasm hosts, older
// Safari). Polyfill it here — this module loads before any span is created —
// so `using` and the `[Symbol.dispose]` method work on every entrypoint.
if (!(Symbol as { dispose?: symbol }).dispose) {
  ;(Symbol as { dispose?: symbol }).dispose = Symbol.for('Symbol.dispose')
}

const g: { crypto?: Crypto; performance?: Performance } = globalThis as never

const randomHex = (bytes: number): string => {
  let s = ''
  for (let i = 0; i < bytes; i++) s += ((Math.random() * 256) | 0).toString(16).padStart(2, '0')
  return s
}

/**
 * Unique id for traces, spans, and events alike.
 *
 * The shape is opaque — nothing in the core depends on it. An OTLP exporter
 * translates these into spec-shaped 16-byte trace / 8-byte span ids (e.g. by
 * hashing) at export time, so the wire format never leaks into the core.
 */
export const uid = (): string =>
  g.crypto?.randomUUID ? g.crypto.randomUUID() : `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(6)}`

/**
 * Wall-clock time in milliseconds since the Unix epoch.
 *
 * Uses `performance.timeOrigin + performance.now()` where available: it is
 * sub-millisecond precise and monotonic within a session, so the same reading
 * serves both timestamps and durations. Falls back to `Date.now()`.
 */
export const now = (): number => (g.performance?.now ? g.performance.timeOrigin + g.performance.now() : Date.now())

/**
 * Checks if a level is enabled based on a minimum level.
 */
export const enabled = (level: Level, layer?: Layer) => level >= (layer?.minLevel ?? Level.TRACE)
