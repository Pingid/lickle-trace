import { installBrowserALS } from './util/als-browser.js'
import { Utils } from './util/index.js'

export { envFilter } from './util/index.js'
export * from './layers/index.js'
export * from './registry.js'
export * from './trace.js'

Object.assign(Utils, {
  now: () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.timeOrigin + performance.now()
      : Date.now(),
})

export const unsafeInstallBrowserALS = () => Object.assign(Utils, { ALS: installBrowserALS() })
