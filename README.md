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

By default nothing is output — install a **layer** to receive spans and events:

```ts
import { defaultTrace } from '@lickle/trace'
import { Console } from '@lickle/trace/layer'
import log from '@lickle/trace/log'

defaultTrace.install(Console.layer())

log.info`server listening on ${8080}`
// ➜ server listening on 8080

await log.span('handle-request', { path: '/users' }, async () => {
  log.debug('querying database')
})
// ➜ enter -> (handle-request) { path: '/users' }
// ➜ querying database
// ➜ exit <- (handle-request) 12.34ms { path: '/users' }
```

### Entrypoints

| Import                    | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `@lickle/trace`           | The core: spans, events, `Trace`, `Layer`, and the default instance        |
| `@lickle/trace/log`       | The macro surface — `info`, `span`, `instrument`, bound to the default     |
| `@lickle/trace/layer`     | `Console`, `compose`, `minLevel`, `filter`, `envFilter`, `sample`, `batch` |
| `@lickle/trace/propagate` | W3C Trace Context — carry a trace across a service boundary                |
| `@lickle/trace/ingest`    | Ingest spans and events from another runtime (wasm, a worker)              |
| `@lickle/trace/test`      | `capture()` — a recording layer for assertions                             |

One universal build serves every runtime. The active-span registry is chosen at
runtime: where `node:async_hooks` is reachable (Node, Deno, Bun) the span chain
is scoped per async task, so concurrent requests never see each other's spans
and unclosed spans can't leak; elsewhere it falls back to a shared stack.

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

// Derive a logger that stamps a target, so `envFilter` can route it
const dbLog = log.target('app:db')
```

Spans measure operations. Called with a function, the span runs through `trace.scope`: it ends when the function returns (or the promise settles — even on throw, recording the cause), and the span chain is confined to the callback. Without a function you get a span handle whose lifetime you own — end it with `.end()` (or a `using` declaration):

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

`instrument` wraps a function so every call is spanned — the equivalent of `#[instrument]`:

```ts
import { instrument } from '@lickle/trace/log'

const handleRequest = instrument('handle-request', async (req: Request) => {
  // ... work ...
})

await handleRequest(req) // spanned, with the rejection recorded if it throws
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

// Drain buffered exporters before the process exits
await trace.flush()
```

Every span and event carries:

- an opaque `id`, and a `parentId` linking it to its parent
- a `traceId`, minted at the root and inherited by every descendant — this is what makes a trace addressable as a whole, for correlation across services, sampling, and export
- a `timestamp` in wall-clock milliseconds (sub-ms precise), and on spans an `endTimestamp` recorded by the core at exit, so every layer reads one agreed duration
- an optional `target` — a `:`-separated module path such as `app:db:pool`, which `envFilter` matches directives against

`Level` is a plain const object of strings (`'trace'`, `'debug'`, `'info'`, `'warn'`, `'error'`), not a TypeScript `enum` — so the package stays type-strippable, and levels are self-describing on the wire.

Custom instances take an injectable context — span registry, layer, clock, and id generator:

```ts
import { createTrace, stackRegistry } from '@lickle/trace'

const trc = createTrace() // async-aware registry where the runtime supports it
const custom = createTrace({ spans: stackRegistry(), now: () => myClock.now(), uid: () => myIds.next() })
```

## Layers

A layer receives span lifecycle callbacks and events. Implement the `Layer` interface to send trace data anywhere. Per-span state lives in a `WeakMap` you own, so it is isolated from other layers and collected with the span:

```ts
import { defaultTrace, Level, type Layer, type Span } from '@lickle/trace'
import { compose, minLevel, envFilter, sample, batch, Console } from '@lickle/trace/layer'

const started = new WeakMap<Span, number>()
const metricsLayer: Layer = {
  minLevel: Level.INFO,
  onEnter: (span) => started.set(span, performance.now()),
  onExit: (span) => metrics.timing(span.name, performance.now() - started.get(span)!),
  onEvent: (evt) => metrics.increment(evt.message ?? 'event'),
}

defaultTrace.install(
  compose(envFilter('info,app:db=debug,app:health=off', Console.layer()), sample(0.01, metricsLayer)),
)
```

- `compose(...layers)` fans callbacks out to every layer, respecting each layer's own `minLevel`, and `flush`es them all.
- `minLevel(level, layer)` returns a copy of `layer` gated to `level` and above.
- `filter(pred, layer)` hides spans/events for which `pred` returns false; a span rejected at creation is hidden for its whole lifecycle.
- `envFilter(spec, layer)` gates by a `tracing`-style directive string matched against `target`. A directive is `level` or `target=level` (or `target=off`); the longest matching target wins, and matching is on `:` segments, so `app` covers `app:db` but not `apple`.
- `sample(rate, layer)` head-samples whole traces. The decision is derived from `traceId`, so it is stateless and every service that sees the same trace makes the same call — a sampled trace stays whole rather than arriving in fragments.
- `batch(send, options)` buffers finished spans and events and hands them to `send` in batches, flushing on size, on an interval, and on `trace.flush()`.

### Console output

`Console.layer()` prints human-readable lines by default. Pass `Console.json` for NDJSON, which emits one complete record per span (on exit, with `endTimestamp` already set) and per event:

```ts
defaultTrace.install(Console.layer({ format: Console.json }))
// ➜ {"id":"...","traceId":"...","type":"span","name":"handle-request", ... }
```

`print` redirects output to any sink: `Console.layer({ print: (level, message, fields) => ... })`.

### Writing an exporter

`batch` and `flush` are the contract an exporter needs — write a `send`, get buffering and draining for free:

```ts
import { batch } from '@lickle/trace/layer'

defaultTrace.install(
  batch((records) => fetch(endpoint, { method: 'POST', body: JSON.stringify(records) }), {
    size: 512,
    interval: 5_000,
  }),
)

process.on('beforeExit', () => defaultTrace.flush())
```

## Propagation

`@lickle/trace/propagate` carries a trace across a service boundary using W3C Trace Context. The core's ids are opaque; the 16-byte trace / 8-byte span hex translation happens here and nowhere else.

```ts
import { inject, withRemoteParent } from '@lickle/trace/propagate'

// Caller: stamp the active span onto outgoing headers
const headers = new Headers()
inject(trace.current(), headers)
await fetch(url, { headers })

// Callee: continue the caller's trace
server.on('request', (req, res) =>
  withRemoteParent(trace, req.headers, `${req.method} ${req.url}`, async () => {
    // spans opened here share the caller's traceId and parent onto its span
    return handle(req, res)
  }),
)
```

A request from an uninstrumented caller still works — it simply starts a new trace. The caller's span is _linked_, not re-reported, so it isn't double-counted at the collector.

## Ingesting from another runtime

`@lickle/trace/ingest` accepts the wire shapes of spans and events created elsewhere — another `Trace`, a worker, the Rust `tracing` bridge over wasm — and replays them into a local trace, resolving parents against the spans currently in flight:

```ts
import { defaultTrace } from '@lickle/trace'
import { createIngest } from '@lickle/trace/ingest'

const ingest = createIngest(defaultTrace)
wasm.onRecord((record) => {
  if (record.type === 'event') ingest.event(record)
  else if (record.endTimestamp) ingest.exit(record)
  else ingest.enter(record)
})
```

## Testing

`@lickle/trace/test` ships the recording layer you'd otherwise hand-roll:

```ts
import { createTrace } from '@lickle/trace'
import { capture } from '@lickle/trace/test'

const sink = capture()
const trace = createTrace({ layer: sink.layer })

trace.scope('work', () => trace.event('done'))

expect(sink.names()).toEqual(['work'])
expect(sink.messages()).toEqual(['done'])
```

## License

MIT © [Dan Beaven](https://github.com/Pingid)
