import { VIEW_LIMITS } from './ui/catalog'
import type { Node, On } from './ui/types'
import { validatePages } from './ui/validate'
import { anything, parseJson, str } from '../schema'

type Step = Extract<On, { op: 'open' | 'close' }>
export interface PreviewAction {
  name: string
  label: string
  palette: boolean
  slash?: string
  args: { name: string; label?: string; type: 'text' }[]
  on: Step
}
export interface PreviewDefinition {
  id: string
  name: string
  author: string
  view: Node
  dialogs: Map<string, Extract<Node, { c: 'dialog' }>>
  actions: PreviewAction[]
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 4096
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(v)
const fail = (why: string): never => {
  throw new Error(why)
}
const step = (v: unknown): v is Step =>
  object(v) && (v.op === 'close' || (v.op === 'open' && identifier(v.dialog)))

// Local action arguments are string literals or references to the current form and invocation.
export function argumentValue(expression: string, values: Record<string, string>): string {
  const ref = /^(?:field|form|args)\.([a-z][a-z0-9_-]{0,39})$/.exec(expression)
  if (ref) return Object.hasOwn(values, ref[1]) ? values[ref[1]] : ''
  if (typeof expression === 'string' && expression.startsWith('"') && expression.length <= 4096) {
    const literal = parseJson(expression, str())
    if (literal.ok) return literal.value
  }
  return fail('Use a quoted string or a field, form or argument reference.')
}

export function readPreview(source: string): PreviewDefinition {
  if (source.length > VIEW_LIMITS.chars) return fail('This definition is too large.')
  const parsed = parseJson(source, anything)
  if (!parsed.ok) return fail('This definition is not valid JSON.')
  const doc = parsed.value
  if (
    !object(doc) ||
    doc.format !== 1 ||
    !identifier(doc.id) ||
    !text(doc.name) ||
    !object(doc.author) ||
    !text(doc.author.name)
  )
    return fail('Choose a format 1 app definition with an ID, name and author.')
  if (
    doc.requires !== undefined &&
    (!object(doc.requires) ||
      Object.keys(doc.requires).some(k => k !== 'capabilities') ||
      (doc.requires.capabilities !== undefined &&
        (!Array.isArray(doc.requires.capabilities) || doc.requires.capabilities.length)))
  )
    return fail('This app needs capabilities unavailable in a local preview.')
  if (
    !Array.isArray(doc.actions) ||
    doc.actions.length > 100 ||
    !Array.isArray(doc.pages) ||
    doc.pages.length !== 1
  )
    return fail('A local preview needs one page and at most 100 actions.')
  const names = new Set<string>()
  const aliases = new Set<string>()
  const actions = doc.actions.map((a: unknown): PreviewAction => {
    if (
      !object(a) ||
      !identifier(a.name) ||
      names.has(a.name) ||
      !text(a.label) ||
      !step(a.on) ||
      a.scope !== 'app' ||
      a.authority !== 'invoker' ||
      a.rule !== 'true' ||
      a.code ||
      a.confirm ||
      a.danger ||
      a.calls ||
      (a.palette !== undefined && typeof a.palette !== 'boolean') ||
      !Array.isArray(a.args) ||
      a.args.length > 1 ||
      !a.args.every(
        f =>
          object(f) &&
          identifier(f.name) &&
          f.type === 'text' &&
          (f.label === undefined || text(f.label))
      )
    )
      return fail('A preview action needs a unique name and a local open or close operation.')
    if (a.slash !== undefined && (!identifier(a.slash) || aliases.has(a.slash)))
      return fail('Choose a unique text alias.')
    names.add(a.name)
    if (typeof a.slash === 'string') aliases.add(a.slash)
    return {
      name: a.name,
      label: a.label,
      palette: a.palette === true,
      slash: a.slash as string | undefined,
      args: a.args,
      on: a.on,
    }
  })
  const issues = validatePages(doc.pages, {
    actions: [...names],
    capabilities: [],
    queries: [],
    plugin: false,
    rule: () => 'Conditional views are unavailable in a local preview.',
  })
  if (issues.length) return fail(issues[0].what)
  const dialogs: PreviewDefinition['dialogs'] = new Map()
  const operations: Step[] = []
  const localStep = (on: On) => {
    if (step(on)) {
      operations.push(on)
      return true
    }
    if (!object(on) || !('action' in on)) return false
    const named = actions.find(a => a.name === on.action)
    if (!named || (on.args !== undefined && !object(on.args))) return false
    for (const [name, expr] of Object.entries(on.args ?? {})) {
      if (!named.args.some(f => f.name === name) || typeof expr !== 'string') return false
      argumentValue(expr, {})
    }
    return true
  }
  const visit = (n: Node) => {
    switch (n.c) {
      case 'dialog':
        if (!identifier(n.name) || !text(n.title) || dialogs.has(n.name))
          return fail('Each dialog needs its own name and title.')
        dialogs.set(n.name, n)
        n.children.forEach(visit)
        return
      case 'stack':
      case 'row':
        n.children.forEach(visit)
        return
      case 'text':
        if (text(n.text)) return
        break
      case 'value':
        if (object(n.bind) && 'field' in n.bind && identifier(n.bind.field)) return
        break
      case 'input':
        if (
          identifier(n.field) &&
          text(n.label) &&
          (!n.kind || n.kind === 'text' || n.kind === 'multiline')
        )
          return
        break
      case 'form':
        if (
          identifier(n.collection) &&
          Array.isArray(n.fields) &&
          n.fields.length <= 40 &&
          n.fields.every(identifier) &&
          text(n.submit) &&
          n.on_done &&
          localStep(n.on_done)
        )
          return
        break
      case 'button':
        if (text(n.label) && object(n.on) && localStep(n.on)) return
        break
    }
    return fail('This component is unavailable in a local preview.')
  }
  const view: Node = doc.pages[0].view
  visit(view)
  for (const op of [...operations, ...actions.map(a => a.on)])
    if (op.op === 'open' && !dialogs.has(op.dialog))
      return fail('The action needs a dialog in this app.')
  return { id: doc.id, name: doc.name, author: doc.author.name, actions, dialogs, view }
}
