import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { Utils } from './util/index.js'

Object.assign(Utils, {
  ALS: new AsyncLocalStorage(),
  now: () => performance.timeOrigin + performance.now(),
})

export { envFilter } from './util/index.js'
export * from './layers/index.js'
export * from './registry.js'
export * from './trace.js'
