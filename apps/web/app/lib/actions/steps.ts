import { useStore } from '../store'
import { guardAction, noLongerAvailable, recheckAction, runAction } from './registry'
import type { Action, ActionCtx, ArgStep, Args, Expansion } from './types'

export type ValueStep = Exclude<ArgStep, { kind: 'confirm' }>
type ConfirmStep = Extract<ArgStep, { kind: 'confirm' }>

export const valueSteps = (a: Action): ValueStep[] =>
  (a.args ?? []).filter((x): x is ValueStep => x.kind !== 'confirm')

// The menus and the palette ask one value step at most, and a choice only with something to pick.
export const askable = (a: Action, ctx: ActionCtx): boolean => {
  const steps = valueSteps(a)
  const [step] = steps
  return (
    steps.length < 2 && (step?.kind !== 'choice' || step.choices(ctx, '').some(c => !c.disabled))
  )
}

// Runs the action once every value step has its argument and its confirm step, if it has one, is
// accepted.
export const confirmThenRun = async (a: Action, ctx: ActionCtx, args: Args): Promise<void> => {
  if (valueSteps(a).some(st => !Object.hasOwn(args, st.name))) return
  const step = (a.args ?? []).find((x): x is ConfirmStep => x.kind === 'confirm')
  if (!step) {
    await runAction(a.id, ctx, args)
    return
  }
  useStore.getState().askConfirm({
    title: step.title,
    body: guardAction(a, () => step.body(ctx, args), ''),
    confirm: step.confirm,
    action: () => void runAction(a.id, ctx, args),
  })
}

export const expansionsOf = (a: Action, ctx: ActionCtx): Expansion[] =>
  a.expand ? guardAction(a, () => a.expand!(ctx), []) : []

export const iconOf = (a: Action, ctx: ActionCtx) =>
  a.iconFor ? guardAction(a, () => a.iconFor!(ctx), a.icon) : a.icon

export const dangerOf = (a: Action, ctx: ActionCtx) =>
  a.dangerFor ? guardAction(a, () => a.dangerFor!(ctx), a.danger) : a.danger

// An expansion row runs with its entry as it is on fresh state, and only while it is still listed.
export const runExpansion = async (a: Action, ctx: ActionCtx, key: string): Promise<void> => {
  const hit = recheckAction(a.id, ctx)
  if (!hit) return
  const entry = expansionsOf(hit.action, hit.ctx).find(x => x.key === key)
  if (!entry) {
    noLongerAvailable()
    return
  }
  await confirmThenRun(hit.action, hit.ctx, entry.args ?? {})
}
