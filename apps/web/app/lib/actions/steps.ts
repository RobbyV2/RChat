import { useStore } from '../store'
import { guardAction, runAction } from './registry'
import type { Action, ActionCtx, ArgStep, Args } from './types'

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
