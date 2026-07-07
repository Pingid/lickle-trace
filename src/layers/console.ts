import { Event, Fields, Span, Layer, Context, Level } from '../trace.js'
import { Utils } from '../util/index.js'

/** Console layer that logs spans and events to the console. */
type ConsoleOpts = {
  timestamps?: boolean
  targets?: boolean
  lifecycle?: { enter?: boolean; exit?: boolean; close?: boolean }
  json?: boolean
}

export class ConsoleLayer implements Layer {
  constructor(
    private print: (level: Level, message: string, fields?: Fields) => void = (level, message, fields) => {
      const m = level === 'trace' ? 'debug' : level
      const fn = ((console as any)?.[m] ?? (console as any)?.log) as (...args: any[]) => void
      fn?.(...(fields ? [message, fields] : [message]))
    },
    private opts: ConsoleOpts = {
      timestamps: true,
      targets: true,
      lifecycle: { enter: true, exit: false, close: true },
    },
  ) {}

  private log(level: Level, message: string, fields?: Fields, meta?: Record<string, unknown>) {
    if (this.opts.json) this.print(level, JSON.stringify({ ...meta, level, message, fields }), undefined)
    else this.print(level, message, fields)
  }

  /** Log when a span is entered. */
  onEnter(span: Span, _cx: Context) {
    if (!this.opts.lifecycle?.enter) return
    const ts = this.opts.timestamps ? new Date().toISOString() + ' ' : ''
    const tgt = this.opts.targets && span.meta.target ? `[${span.meta.target}] ` : ''
    this.log(span.meta.level, `${ts}${tgt}enter -> (${span.meta.name})`, span.meta.fields, {
      kind: 'span',
      id: span.id,
      parent: span.meta.parent,
      target: span.meta.target,
      file: span.meta.file,
      line: span.meta.line,
      name: span.meta.name,
      ts: span.meta.ts,
    })
  }

  /** Log when a span is exited. */
  onExit(span: Span, _cx: Context) {
    if (!this.opts.lifecycle?.exit) return
    const ts = this.opts.timestamps ? new Date().toISOString() + ' ' : ''
    const tgt = this.opts.targets && span.meta.target ? `[${span.meta.target}] ` : ''
    this.log(span.meta.level, `${ts}${tgt}exit <- (${span.meta.name})`, span.meta.fields, {
      kind: 'span',
      id: span.id,
      parent: span.meta.parent,
      target: span.meta.target,
      file: span.meta.file,
      line: span.meta.line,
      name: span.meta.name,
      ts: span.meta.ts,
    })
  }

  onClose(span: Span, _cx: Context) {
    if (!this.opts.lifecycle?.close) return
    const ts = this.opts.timestamps ? new Date().toISOString() + ' ' : ''
    const tgt = this.opts.targets && span.meta.target ? `[${span.meta.target}] ` : ''
    const d = Utils.now() - span.meta.ts
    this.log(span.meta.level, `${ts}${tgt}close x (${span.meta.name}) ${d.toFixed(2)}ms`, span.meta.fields, {
      kind: 'span',
      id: span.id,
      parent: span.meta.parent,
      target: span.meta.target,
      file: span.meta.file,
      line: span.meta.line,
      name: span.meta.name,
      ts: span.meta.ts,
      durMs: d,
    })
  }

  /** Log an event. */
  onEvent(e: Event, _cx: Context): void {
    const ts = this.opts.timestamps ? new Date().toISOString() + ' ' : ''
    const tgt = this.opts.targets && e.meta.target ? `[${e.meta.target}] ` : ''
    this.log(
      e.meta.level,
      `${ts}${tgt}${e.meta.name ? `(${e.meta.name})` : ''}${e.message ? ` ${e.message}` : ''}`,
      e.meta.fields,
      {
        kind: 'event',
        id: e.id,
        parent: e.meta.parent,
        target: e.meta.target,
        file: e.meta.file,
        line: e.meta.line,
        name: e.meta.name,
        ts: e.meta.ts,
      },
    )
  }
}
