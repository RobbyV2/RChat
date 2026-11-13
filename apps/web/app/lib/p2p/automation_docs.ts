import { isRecord } from '../bytes'
import { bytesOf, canonical, utf8 } from './canonical'

// Automation and onboarding docs of a P2P server: content events (`auto`, `onb`, `press`) that
// a client which doesn't know these kinds stores and ignores. Nothing here strikes: a doc or
// press that can't be read is inert.

export const CAPS = {
  automations: 50,
  keywords: 250,
  regexes: 5,
  questions: 10,
  choices: 10,
  rules: 10,
  bytes: 16 * 1024,
} as const

const EVENT_ID_LEN = 32
const ID = /^[A-Za-z0-9_-]{1,64}$/
const CID_MAX = 32
const WANT_MAX = 25

export interface Ev {
  id: string
  deps: string[]
}

const smaller = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// A deterministic topological order of the events held: Kahn's algorithm, taking the smallest id
// among the ready events at each step. Dependencies on events not held are ignored.
export const topoOrder = (events: Ev[]): string[] => {
  const held = new Map<string, Ev>()
  for (const e of events) if (!held.has(e.id)) held.set(e.id, e)
  const waits = new Map<string, number>()
  const after = new Map<string, string[]>()
  for (const e of held.values()) {
    const deps = [...new Set(e.deps)].filter(d => d !== e.id && held.has(d))
    waits.set(e.id, deps.length)
    for (const d of deps) {
      const list = after.get(d)
      if (list) list.push(e.id)
      else after.set(d, [e.id])
    }
  }
  // A binary heap of the ready ids.
  const ready: string[] = []
  const push = (id: string) => {
    let i = ready.push(id) - 1
    while (i > 0) {
      const up = (i - 1) >> 1
      if (ready[up] <= ready[i]) break
      ;[ready[up], ready[i]] = [ready[i], ready[up]]
      i = up
    }
  }
  const pop = () => {
    const top = ready[0]
    const last = ready.pop() as string
    if (!ready.length) return top
    ready[0] = last
    for (let i = 0; ;) {
      const l = 2 * i + 1
      const r = l + 1
      let least = i
      if (l < ready.length && ready[l] < ready[least]) least = l
      if (r < ready.length && ready[r] < ready[least]) least = r
      if (least === i) return top
      ;[ready[least], ready[i]] = [ready[i], ready[least]]
      i = least
    }
  }
  for (const [id, n] of waits) if (n === 0) push(id)
  const out: string[] = []
  while (ready.length) {
    const id = pop()
    out.push(id)
    for (const next of after.get(id) ?? []) {
      const n = (waits.get(next) ?? 0) - 1
      waits.set(next, n)
      if (n === 0) push(next)
    }
  }
  return out
}

export type OnbPart = 'requirements' | 'rules' | 'questions' | 'welcome'
const PARTS: readonly OnbPart[] = ['requirements', 'rules', 'questions', 'welcome']

export interface AutoDoc {
  id: string
  v: 1
  // The automation, in the shape the shared rules read. Empty when `gone`.
  body: Record<string, unknown>
  gone: boolean
}

export interface OnbDoc {
  part: OnbPart
  v: 1
  body: Record<string, unknown>
}

export type Want = 'on' | 'off' | string[]

export interface PressDoc {
  target: string
  cid: string
  want: Want
}

const typed = (x: unknown) => isRecord(x) && typeof x.type === 'string'

const bodyOk = (b: unknown): b is Record<string, unknown> =>
  isRecord(b) &&
  (b.name === undefined || typeof b.name === 'string') &&
  typed(b.trigger) &&
  Array.isArray(b.actions) &&
  b.actions.every(typed) &&
  (b.conditions === undefined || (Array.isArray(b.conditions) && b.conditions.every(typed)))

export const parseAuto = (c: unknown): AutoDoc | null => {
  if (!isRecord(c) || c.v !== 1 || typeof c.id !== 'string' || !ID.test(c.id)) return null
  if (c.gone !== undefined && typeof c.gone !== 'boolean') return null
  if (c.gone) return { id: c.id, v: 1, body: {}, gone: true }
  return bodyOk(c.body) ? { id: c.id, v: 1, body: c.body, gone: false } : null
}

export const parseOnb = (c: unknown): OnbDoc | null => {
  if (!isRecord(c) || c.v !== 1 || !isRecord(c.body)) return null
  const part = PARTS.find(p => p === c.part)
  return part ? { part, v: 1, body: c.body } : null
}

const wantOk = (w: unknown): w is Want =>
  w === 'on' ||
  w === 'off' ||
  (Array.isArray(w) &&
    w.length <= WANT_MAX &&
    w.every(r => typeof r === 'string' && r.length > 0) &&
    new Set(w).size === w.length)

export const parsePress = (c: unknown): PressDoc | null =>
  isRecord(c) &&
  bytesOf(c.target, EVENT_ID_LEN) !== null &&
  typeof c.target === 'string' &&
  typeof c.cid === 'string' &&
  c.cid.length > 0 &&
  c.cid.length <= CID_MAX &&
  wantOk(c.want)
    ? { target: c.target, cid: c.cid, want: c.want }
    : null

// Whether a doc is within the size of one content event.
export const docFits = (c: unknown) => {
  try {
    return utf8(canonical(c)).length <= CAPS.bytes
  } catch {
    return false
  }
}

// Every condition of a body, the nested ones too.
const conditionsOf = (x: unknown): Record<string, unknown>[] => {
  if (Array.isArray(x)) return x.flatMap(conditionsOf)
  if (!isRecord(x)) return []
  return [x, ...conditionsOf(x.of)]
}

const listed = (x: unknown, max: number) => x === undefined || (Array.isArray(x) && x.length <= max)

const autoWithin = (body: Record<string, unknown>) => {
  const all = conditionsOf(body.conditions)
  const keywords = all.filter(c => c.type === 'keywords')
  const names = all.filter(c => c.type === 'name')
  const regexes = all.filter(c => c.type === 'regex')
  return (
    keywords.every(c => listed(c.list, CAPS.keywords) && listed(c.allow, CAPS.keywords)) &&
    names.every(c => listed(c.list, CAPS.keywords)) &&
    regexes.every(c => Array.isArray(c.patterns)) &&
    regexes.reduce((n, c) => n + (c.patterns as unknown[]).length, 0) <= CAPS.regexes
  )
}

const onbWithin = ({ part, body }: OnbDoc) => {
  const items = body.items
  switch (part) {
    case 'rules':
      return listed(items, CAPS.rules)
    case 'questions':
      return (
        listed(items, CAPS.questions) &&
        ((items ?? []) as unknown[]).every(q => isRecord(q) && listed(q.options, CAPS.choices))
      )
    case 'requirements':
    case 'welcome':
      return true
  }
}

// The instance's profanity preset never runs on P2P content: a doc that names it is read
// without it.
const withoutPreset = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(withoutPreset)
  if (!isRecord(x)) return x
  const { profanity_preset: _, of, ...rest } = x
  return of === undefined ? rest : { ...rest, of: withoutPreset(of) }
}

export interface DocEvent extends Ev {
  author: string
  kind: string
  content: unknown
  // Where it was posted.
  channel?: string
}

export interface Held<T> {
  doc: T
  event: string
  author: string
  channel?: string
}

export interface Docs {
  // By id, at most 50.
  autos: Held<AutoDoc>[]
  onboarding: Partial<Record<OnbPart, Held<OnbDoc>>>
}

// The docs that apply: per automation id and per onboarding part, the newest valid doc in the
// reader's causal order whose author holds Manage server in the final ACL state. A doc whose
// author lost it, or that can't be read, is passed over and the one before applies.
export const resolveDocs = (
  events: DocEvent[],
  managesServer: (author: string) => boolean
): Docs => {
  const byId = new Map(events.map(e => [e.id, e]))
  const autos = new Map<string, Held<AutoDoc>>()
  const onboarding = new Map<OnbPart, Held<OnbDoc>>()
  const may = new Map<string, boolean>()
  const manages = (author: string) => {
    const known = may.get(author)
    if (known !== undefined) return known
    const now = managesServer(author)
    may.set(author, now)
    return now
  }
  for (const id of topoOrder(events)) {
    const e = byId.get(id)
    if (!e || (e.kind !== 'auto' && e.kind !== 'onb') || !manages(e.author)) continue
    const held = { event: e.id, author: e.author, ...(e.channel ? { channel: e.channel } : {}) }
    if (e.kind === 'auto') {
      const doc = parseAuto(e.content)
      if (!doc || !autoWithin(doc.body)) continue
      const body = { ...doc.body, conditions: withoutPreset(doc.body.conditions ?? []) }
      autos.set(doc.id, { ...held, doc: doc.gone ? doc : { ...doc, body } })
    } else {
      const doc = parseOnb(e.content)
      if (doc && onbWithin(doc)) onboarding.set(doc.part, { ...held, doc })
    }
  }
  return {
    autos: [...autos.values()]
      .filter(a => !a.doc.gone)
      .sort((a, b) => smaller(a.doc.id, b.doc.id))
      .slice(0, CAPS.automations),
    onboarding: Object.fromEntries(onboarding),
  }
}

export interface P2pOnboarding {
  requirements: Record<string, unknown> | null
  rules: Record<string, unknown> | null
  questions: Record<string, unknown> | null
  welcome: Record<string, unknown> | null
  // Whose docs these are: each part stops applying when its author loses Manage server.
  savedBy: string[]
}

export const onboardingOf = ({ onboarding }: Docs): P2pOnboarding => ({
  requirements: onboarding.requirements?.doc.body ?? null,
  rules: onboarding.rules?.doc.body ?? null,
  questions: onboarding.questions?.doc.body ?? null,
  welcome: onboarding.welcome?.doc.body ?? null,
  savedBy: [...new Set(PARTS.flatMap(p => onboarding[p]?.author ?? []))].sort(smaller),
})
