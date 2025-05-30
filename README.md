# @lickle/trace

A minimal, structured tracing utility for TypeScript/JavaScript, inspired by Rust's `tracing` crate. It provides spans, events, and a higher-level logging abstraction.

[![Build Status](https://img.shields.io/github/actions/workflow/status/Pingid/lickle-trace/test.yml?branch=main&style=flat&colorA=000000&colorB=000000)](https://github.com/Pingid/lickle-trace/actions?query=workflow:Test)
[![Build Size](https://img.shields.io/bundlephobia/minzip/@lickle/trace?label=bundle%20size&style=flat&colorA=000000&colorB=000000)](https://bundlephobia.com/result?p=@lickle/trace)
[![Version](https://img.shields.io/npm/v/@lickle/trace?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/trace)
[![Downloads](https://img.shields.io/npm/dt/@lickle/trace.svg?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@lickle/trace)

## Installation

Install the `@lickle/trace` library using your preferred package manager:

```bash
npm install @lickle/trace
```

## Usage

`@lickle/trace` has two main interfaces: a high-level Logger for common logging patterns and a low-level Trace API for fine-grained control and custom integrations.

**1. Attaching a Subscriber (Required)**  
 By default, `@lickle/trace` doesn't output anything. You need to attach a subscriber to process trace events. The simplest way is to use the built-in console subscriber:

```typescript
import { Builder, ConsoleLayer, Level } from '@lickle/trace/subscribe'

// Configure and install a subscriber to log INFO level and above to the console.
new Builder().withMinLevel(Level.INFO).withLayer(new ConsoleLayer()).install()

// Now, all trace events and spans at INFO level and above will appear in your console.
```

You can also create custom subscribers to send trace data to external services (e.g., logging aggregators, metrics systems). See the [Subscribe Module](#subscribe-module) section for details.

**2. Using the Logger**  
 The `log` module provides an ergonomic, template-literal-friendly logger with `levels` and `spans`. It's a thin wrapper around the core trace API.

```typescript
import logger, { info, error, span } from '@lickle/trace/log'

// Simple messages
info`App started`
// ➜ [INFO] (): App started

// Template literals with interpolated data
const requestId = 'abc123'
info`Handling request ${requestId}`
// ➜ [INFO] (): Handling request abc123

// Structured logging with metadata fields
info({ userId: 'u-42' })`User logged in`
// ➜ [INFO] (): User logged in { userId: 'u-42' }

// Logging errors directly
try {
  throw new Error('Something went wrong')
} catch (err) {
  error(err)
}
// ➜ [ERROR] (Error): Something went wrong { stack: '...', name: 'Error' }

// Creating a span to measure operation duration
span('process-order', { orderId: 'o-99' }, async () => {
  // ... perform work ...
})
// ➜ [INFO] [SPAN:ENTER] (process-order) { orderId: 'o-99' }
// ➜ [INFO] [SPAN:EXIT] (process-order) (23.45ms) { orderId: 'o-99' }
```

> **Note**: The default logger instance automatically uses the globally configured trace. You can also instantiate Logger with a custom Trace instance if needed.

**3. Using the Core Trace API**  
 The core `trace` module offers low-level control over spans and events. Use this when you need custom behavior or want to integrate with a specific tracing backend.

```typescript
import { Trace, event, span, Level, defaultTrace, setSubscriber, getSubscriber } from '@lickle/trace/trace'

// Emitting a standalone event
event('startup', Level.INFO, 'Application initialized')
// ➜ [INFO] (startup): Application initialized

// Creating and manually managing a span
const dbQuerySpan = span('db.query', Level.DEBUG, { sql: 'SELECT * FROM users' })
try {
  // ... perform DB query ...
} finally {
  defaultTrace.exit(dbQuerySpan) // Explicitly exit the span
}
// ➜ [DEBUG] [SPAN:ENTER] (db.query) { sql: 'SELECT * FROM users' }
// ➜ [DEBUG] [SPAN:EXIT] (db.query) (5.67ms) { sql: 'SELECT * FROM users' }

// Using an ad-hoc Trace instance with a custom subscriber
const customTrace = new Trace({
  minLevel: Level.INFO,
  onEvent(evt) {
    // Example: send to a remote log aggregator
    // remoteLogger.send(evt);
    console.log('CUSTOM EVENT:', evt.message)
  },
  onEnter: (span) => console.log('SPAN ENTERED:', span.meta.name),
  onExit: (span) => console.log('SPAN EXITED:', span.meta.name, 'took', Date.now() - span.meta.ts, 'ms'),
})

customTrace.span('cache-warm', Level.INFO, { cache: 'redis' }, () => {
  // ... warm cache ...
})
// ➜ SPAN ENTERED: cache-warm
// ➜ CUSTOM EVENT: Span 'cache-warm' started. (Internal trace event if implemented)
// ➜ SPAN EXITED: cache-warm took 12.34 ms
```

## API Reference

### Core Trace Module

`@lickle/trace/trace` The `Trace` class and associated types are the foundation of the library.

- `new Trace(subscriber?: Subscriber)`

  Creates a new tracing instance. If no `subscriber` is provided, it uses a no-op subscriber.

- `trace.span(name: string, level?: Level, fields?: Fields) → Span`

  Starts a new span if `level` meets the subscriber's `minLevel`. Returns a `Span` object with `id` and `meta`.

- `trace.exit(span: Span)`

  Ends a span and notifies subscribers. Only pops the span from the internal stack if it's the topmost.

- `trace.event(name: string | undefined, level: Level, message?: string, fields?: Fields)`

  Emits a one-off log event.

- `trace.enter(span: Span)`

  Manually pushes an existing span onto the active span stack. Rarely needed for typical usage.

- `trace.getSubscriber()` / `trace.setSubscriber(subscriber)`

  Inspect or replace the subscriber for this Trace instance.

- `Level` (enum): Log severity levels (ascending order).

  ```typeScript
  enum Level {
    TRACE = 10,
    DEBUG = 20,
    INFO = 30,
    WARN = 40,
    ERROR = 50,
  }
  ```

- `defaultTrace`: A globally exported Trace instance.

- `setSubscriber(subscriber)`: Helper to set the subscriber for defaultTrace.

- `getSubscriber()`: Helper to get the subscriber from defaultTrace.

### Subscribe Module

`@lickle/trace/subscribe` Provides tools for building and installing subscribers.

- `new Builder()`

  Creates a fluent subscriber builder.

- `.withMinLevel(level: Level) → Builder`

  Sets the minimum log level for the subscriber. Only events/spans at this level or higher will be processed.

- `.withLayer(layer: Subscriber) → Builder`

  Adds one or more subscriber layers. You can use `ConsoleLayer` or your own custom implementations.

- `.install(trace?: Trace) → void`

  Installs the configured subscriber. If `trace` is provided, it installs into that specific `Trace` instance; otherwise, it installs into the `defaultTrace`.

- `ConsoleLayer` (class)

  A built-in `Subscriber` that logs events and spans to the console using appropriate `console` methods.

- `onEnter(span: Span)`: Logs span entry.
- `onExit(span: Span)`: Logs span exit, including duration.
- `onEvent(evt: Event)`: Logs events with message and fields.

### Custom Subscriber Example

```typescript
import { Level, Subscriber } from '@lickle/trace/trace'
import { Builder } from '@lickle/trace/subscribe'

const metricsLayer: Subscriber = {
  minLevel: Level.INFO,
  onEvent(evt) {
    // Example: Increment a metric counter for each INFO+ event
    // metrics.increment(evt.meta.name ?? 'unknown_event');
    console.log(`METRIC: Event '${evt.meta.name}' occurred.`)
  },
  newSpan(meta) {
    // Example: Return a custom Span shape for specific needs
    return { id: `${meta.name}-${Date.now()}`, meta }
  },
  onEnter(span) {
    // Example: Start a timer in a metrics backend for this span
    // metrics.startTimer(span.id);
    console.log(`METRIC: Timer started for span '${span.meta.name}'.`)
  },
  onExit(span) {
    // Example: Stop the timer and record the duration
    // metrics.stopTimer(span.id);
    console.log(`METRIC: Timer stopped for span '${span.meta.name}'.`)
  },
}

new Builder().withLayer(metricsLayer).install()
```

## License

This project is licensed under the MIT License.

MIT © [Dan Beaven](https://github.com/Pingid)
