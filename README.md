# @lickle/trace

Minimal structured tracing for TypeScript/JavaScript, inspired by Rust’s [`tracing`](https://docs.rs/tracing).  
Provides **spans**, **events**, and a pluggable subscriber system.

[![Build Status](https://img.shields.io/github/actions/workflow/status/Pingid/lickle-trace/test.yml?branch=main&style=flat&colorA=000000&colorB=000000)](https://github.com/Pingid/lickle-trace/actions?query=workflow:Test)
[![Build Size](https://img.shields.io/bundlephobia/minzip/@lickle/trace?label=bundle%20size&style=flat&colorA=000000&colorB=000000)](https://bundlephobia.com/result?p=@lickle/trace)
[![Version](https://img.shields.io/npm/v/@lickle/trace?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/trace)
[![Downloads](https://img.shields.io/npm/dt/@lickle/trace.svg?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/trace)

## Install

```bash
npm install @lickle/trace
```

---

## Quick Start

By default nothing is logged—you need to attach a **subscriber**.  
The simplest option is the built-in `ConsoleLayer`:

```ts
import { Builder, ConsoleLayer, Level } from '@lickle/trace/subscribe'

new Builder().withMinLevel(Level.INFO).withLayer(new ConsoleLayer()).install()
```

Now `INFO`+ events will print to the console.

---

## Examples

### Events

```ts
import { event, Level } from '@lickle/trace/trace'

event('startup', Level.INFO, 'Application ready')
// [INFO] (startup): Application ready
```

### Spans

```ts
import { span, exit, Level } from '@lickle/trace/trace'

const s = span('db.query', Level.DEBUG, { sql: 'SELECT *' })
try {
  // run query...
} finally {
  exit.exit(s)
}
// [DEBUG] enter -> (db.query)
// [DEBUG] exit <- (db.query) 5.67ms { sql: 'SELECT *' }
```

### Custom Subscriber

```ts
import { Builder } from '@lickle/trace/subscribe'
import { Level, Subscriber } from '@lickle/trace/trace'

const metrics: Subscriber = {
  minLevel: Level.INFO,
  onEvent(evt) {
    console.log(`METRIC: Event '${evt.meta.name}'`)
  },
}

new Builder().withLayer(metrics).install()
```

---

## API

### Core (`@lickle/trace/trace`)

- `Trace` – manages spans and events
- `event(name, level, message?, fields?)`
- `span(name, level?, fields?) → Span`
- `enter(span)`, `exit(span)`
- `setSubscriber(sub)`, `getSubscriber()`
- `defaultTrace` – global instance
- `Level` – severity enum (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`)

### Subscribe (`@lickle/trace/subscribe`)

- `Builder` – fluent builder for subscribers
  - `.withMinLevel(level)`
  - `.withLayer(subscriber)`
  - `.install(trace?)`
- `ConsoleLayer` – logs spans/events to the console

---

## License

MIT © [Dan Beaven](https://github.com/Pingid)
