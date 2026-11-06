// Every action the menus, sheets and the palette show. This module loads without the store
// (ctx.ts binds it), so a page without the app can still define actions.

import type { Action, ActionCtx, Args, Scope } from './types'

interface Host {
  refresh(ctx: ActionCtx): ActionCtx | null
  gone(): void
}

let host: Host = { refresh: ctx => ctx, gone: () => {} }

export const bindActionHost = (next: Host) => {
  host = next
}

const ID = /^[\w-]+(?:\.[\w-]+)*$/
const ID_MAX = 200

// Ids without a namespace are the built-ins, `core.<id>`; only they register bare.
export const qualifiedId = (id: string) => (id.includes('.') ? id : `core.${id}`)

// One object per registration, so an unregister only removes its own.
const entries = new Map<string, { action: Action }>()
const failed = new Set<string>()
const listeners = new Set<() => void>()
let listed: readonly Action[] | null = null
let version = 0

const changed = () => {
  listed = null
  version += 1
  for (const cb of [...listeners])
    try {
      cb()
    } catch (e) {
      console.error('action listener', e)
    }
}

export const subscribeActions = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export const actionsVersion = () => version

export const defineAction = <A extends Args = Args>(a: Action<A>): (() => void) => {
  const action = a as unknown as Action
  if (
    typeof a.id !== 'string' ||
    a.id.length > ID_MAX ||
    !ID.test(a.id) ||
    a.id.startsWith('core.')
  ) {
    console.error('bad action id', a.id)
    return () => {}
  }
  const key = qualifiedId(a.id)
  if (entries.has(key)) {
    console.error('duplicate action', a.id)
    return () => {}
  }
  const entry = { action }
  entries.set(key, entry)
  changed()
  return () => {
    if (entries.get(key) !== entry) return
    entries.delete(key)
    failed.delete(key)
    changed()
  }
}

export const actionById = (id: string): Action | undefined => entries.get(qualifiedId(id))?.action

export const allActions = (): readonly Action[] =>
  (listed ??= [...entries.values()].map(e => e.action))

// Runs one of the action's own functions; when it throws, the action shows as `fallback` and
// the error is logged once.
export const guardAction = <T>(a: Action, f: () => T, fallback: T): T => {
  try {
    return f()
  } catch (e) {
    const key = qualifiedId(a.id)
    if (!failed.has(key)) {
      failed.add(key)
      console.error('action', a.id, e)
    }
    return fallback
  }
}

export const isAvailable = (a: Action, ctx: ActionCtx) =>
  guardAction(a, () => a.available(ctx), false)

const byOrder = (list: Action[]) => list.sort((a, b) => (a.order ?? 500) - (b.order ?? 500))

export const actionsFor = (ctx: ActionCtx, scopes?: Scope | readonly Scope[]): Action[] => {
  const want = scopes === undefined ? null : typeof scopes === 'string' ? [scopes] : scopes
  return byOrder(allActions().filter(a => (!want || want.includes(a.scope)) && isAvailable(a, ctx)))
}

export const targetActions = (ctx: ActionCtx): Action[] =>
  byOrder(allActions().filter(a => a.targets?.includes(ctx.target.kind) && isAvailable(a, ctx)))

export const labelOf = (a: Action, ctx: ActionCtx): string =>
  a.label ? guardAction(a, () => a.label!(ctx), a.title) : a.title

// The action and its context on fresh state, or null (said once) when it is no longer there.
export const recheckAction = (
  id: string,
  ctx: ActionCtx
): { action: Action; ctx: ActionCtx } | null => {
  const action = actionById(id)
  const fresh = action ? host.refresh(ctx) : null
  if (action && fresh && isAvailable(action, fresh)) return { action, ctx: fresh }
  host.gone()
  return null
}

// Says that what an action was opened on is gone.
export const noLongerAvailable = () => host.gone()

export const runAction = async (id: string, ctx: ActionCtx, args: Args = {}): Promise<boolean> => {
  const hit = recheckAction(id, ctx)
  if (!hit) return false
  await hit.action.run(hit.ctx, args)
  return true
}
