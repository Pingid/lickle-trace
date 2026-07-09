# @lickle/trace

A minimal, structured tracing library for TypeScript/JavaScript, inspired by Rust's [`tracing`](https://docs.rs/tracing) crate. It provides spans, events, and an ergonomic template-literal logger on top.

[![Build Status](https://img.shields.io/github/actions/workflow/status/Pingid/lickle-trace/test.yml?branch=main&style=flat&colorA=000000&colorB=000000)](https://github.com/Pingid/lickle-trace/actions?query=workflow:Test)
[![Build Size](https://img.shields.io/bundlephobia/minzip/@lickle/trace?label=bundle%20size&style=flat&colorA=000000&colorB=000000)](https://bundlephobia.com/result?p=@lickle/trace)
[![Version](https://img.shields.io/npm/v/@lickle/trace?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/trace)
[![Downloads](https://img.shields.io/npm/dt/@lickle/trace.svg?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/trace)

## Installation

```bash
npm install @lickle/trace
```

## Quick start

By default nothing is output — install a **layer** to receive spans and events. `init()` is a shortcut that installs the built-in console layer on the default trace:

```ts
import { init } from '@lickle/trace'
import log from '@lickle/trace/log'

init() // shorthand for: defaultTrace.install(Console.layer())

log.info`server listening on ${8080}`
// ➜ server listening on 8080

await log.span('handle-request', { path: '/users' }, async () => {
  log.debug('querying database')
})
// ➜ enter -> (handle-request) { path: '/users' }
// ➜  querying database
// ➜ exit <- (handle-request) 12.34ms { path: '/users' }
```

### Entrypoints

| Import                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `@lickle/trace`       | The core trace API and default instance, resolved per platform |
| `@lickle/trace/log`   | The default logger and its methods, bound to the default trace |
| `@lickle/trace/layer` | `Console`, `compose`, `minLevel`, `filter`                     |

The root import adapts via export conditions: on Node the active-span registry is the `AsyncLocalStorage`-backed build — the span chain is scoped per async task, so concurrent requests never see each other's spans and unclosed spans can't leak — while browsers and other runtimes get a universal shared-stack build. The correct registry is selected automatically, so there is no separate entrypoint to import.

## The logger

The logger is a thin, ergonomic wrapper over the trace API with `trace`/`debug`/`info`/`warn`/`error` methods.

```ts
import log, { createLog } from '@lickle/trace/log'

// Template literals
log.info`Handling request ${requestId}`

// Plain messages
log.info('Application started')

// Structured fields — pass metadata with a message...
log.info({ userId: 'u-42' }, 'User logged in')

// ...or attach metadata first, then log. Note: nothing is emitted
// until the returned function is called.
log.info({ userId: 'u-42' })`User logged in`

// Errors capture stack, name, and cause as fields
try {
  throw new Error('Something went wrong')
} catch (err) {
  log.error(err)
}

// Derive a logger that merges fields into everything it emits.
// Derivations compose: log.with(a).with(b) merges both.
const apiLog = log.with({ service: 'gateway' })
apiLog.warn('rate limited') // fields: { service: 'gateway' }
```

Spans measure operations. Called with a function, the span runs through `trace.scope`: it ends when the function returns (or the promise settles — even on throw), and under the Node build the span chain is confined to the callback. Without a function you get a span handle whose lifetime you own — end it with `.end()` (or a `using` declaration):

```ts
// Runs at INFO by default; per-level variants are available
await log.span('process-order', { orderId: 'o-99' }, async () => {
  // ... work ...
})

log.span.debug('parse-config', () => {
  // ... work ...
})

const span = log.span('read-file')
try {
  // ... work ...
} finally {
  span.end()
}
```

## The trace API

A `Trace` is the core: it creates spans, emits events, and forwards both to the installed layer. `createTrace` builds one, and a default instance (`defaultTrace`) is exported alongside the bound logger helpers.

```ts
import { defaultTrace as trace, Level } from '@lickle/trace'

// One-off events, attributed to the active span if one exists
trace.event('Application initialized', Level.INFO)

// Spans are disposable — `using` ends them at scope exit
{
  using sp = trace.span('db.query', Level.DEBUG, { sql: 'SELECT 1' })
  sp.setFields({ rows: 3 })
}

// Or scope a function; the span ends when it returns/settles
await trace.scope('warm-cache', async (sp) => {
  sp.setFields({ keys: 128 })
})

// Explicit parenting that never depends on the active stack
const parent = trace.span('request')
const child = parent.child('validate')
child.end()
parent.end()
```

Each span carries an opaque `id` and `parentId`, and both spans and events carry a `timestamp` in wall-clock milliseconds (sub-ms precise); diff two timestamps for a duration. The ids are opaque strings — an OTLP exporter translates them into spec-shaped 16-byte trace / 8-byte span ids at export time.

Custom instances take an injectable context — span registry, layer, clock, and id generator:

```ts
import { createTrace, alsRegistry } from '@lickle/trace'

const trc = createTrace() // uses the platform-default registry (ALS on Node)
const custom = createTrace({ spans: alsRegistry(), now: () => myClock.now(), uid: () => myIds.next() })
```

## Layers

A layer receives span lifecycle callbacks and events. Implement the `Layer` interface to send trace data anywhere:

```ts
import { defaultTrace, Level, type Layer } from '@lickle/trace'
import { compose, minLevel, filter, Console } from '@lickle/trace/layer'

const metricsLayer: Layer<{ start: number }> = {
  minLevel: Level.INFO,
  newSpan: () => ({ start: performance.now() }), // stored on span.ext
  onExit: (span) => metrics.timing(span.name, performance.now() - span.ext!.start),
  onEvent: (evt) => metrics.increment(evt.message ?? 'event'),
}

defaultTrace.install(
  compose(
    minLevel(Level.WARN, Console.layer()), // console only sees WARN+
    filter((item) => item.type !== 'span' || item.name !== 'health-check', metricsLayer),
  ),
)
```

- `compose(...layers)` fans callbacks out to every layer, respecting each layer's own `minLevel` and keeping `span.ext` state isolated per layer.
- `minLevel(level, layer)` returns a copy of `layer` gated to `level` and above.
- `filter(pred, layer)` hides spans/events for which `pred` returns false; a span rejected at creation is hidden for its whole lifecycle.

## License

MIT © [Dan Beaven](https://github.com/Pingid)
