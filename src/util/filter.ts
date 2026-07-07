import { Levels, type Level, type Metadata } from '../trace.js'

type LayerFilter = (kind: 'event' | 'span', meta: Metadata) => boolean

type Rule = {
  kinds?: Set<'event' | 'span'>
  target?: string
  prefix?: string
  field?: string
  fieldValue?: string
  level: Level
}

export const envFilter = (spec: string): LayerFilter => {
  const rules = parseSpec(spec)
  return (kind, m) => {
    let hit: Rule | undefined
    for (const r of rules) {
      if (r.kinds && !r.kinds.has(kind)) continue
      let ok = true
      if (r.target) ok = r.target === m.target || r.target === m.name
      else if (r.prefix) ok = (m.target?.startsWith(r.prefix) || m.name?.startsWith(r.prefix)) ?? false
      if (!ok) continue
      if (r.field) {
        const v = m.fields?.[r.field]
        if (typeof r.fieldValue !== 'undefined') {
          if (`${v}` !== r.fieldValue) continue
        } else if (typeof v === 'undefined') continue
      }
      hit = r
    }
    return hit ? Levels[m.level] >= Levels[hit.level] : true
  }
}

function parseSpec(spec: string): Rule[] {
  const out: Rule[] = []
  for (const raw of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [lhs0, rhs0] = raw.split('=') as [string, string | undefined]
    const lvl = (rhs0 ? rhs0.trim() : 'trace') as Level
    if (!Levels[lvl]) continue
    const rule: Rule = { level: lvl }
    const kindM = lhs0.match(/^(span|event):(.*)$/)
    let expr = kindM ? (kindM[2] ?? '').trim() : lhs0.trim()
    if (kindM) rule.kinds = new Set([kindM[1] as 'event' | 'span'])
    if (expr.startsWith('[') && expr.endsWith(']')) {
      let inner = expr.slice(1, -1).trim()
      if (inner.startsWith('{') && inner.endsWith('}')) inner = inner.slice(1, -1).trim()
      const [fk, fv] = inner.split('=').map((s) => s.trim())
      if (fk) {
        rule.field = fk
        if (typeof fv !== 'undefined' && fv !== '') rule.fieldValue = fv
      }
    } else if (expr && expr !== '*') {
      if (expr.endsWith('*')) rule.prefix = expr.slice(0, -1)
      else rule.target = expr
    }
    out.push(rule)
  }
  return out
}
