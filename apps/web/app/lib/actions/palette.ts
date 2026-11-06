import type { ArgSpec, PaletteCommand } from '../palette'
import { allActions, guardAction, isAvailable, labelOf } from './registry'
import { askable, confirmThenRun, valueSteps, type ValueStep } from './steps'
import type { Action, ActionCtx } from './types'

const argOf = (step: ValueStep, ctx: ActionCtx): ArgSpec => {
  if (step.kind === 'choice')
    return {
      placeholder: step.prompt,
      choices: step
        .choices(ctx, '')
        .filter(c => !c.disabled)
        .map(({ value, label, subtitle }) => ({ value, label, subtitle })),
    }
  const check = step.check
  return { placeholder: step.prompt, check: check && (text => check(text, ctx)) }
}

export const paletteRow = (a: Action, ctx: ActionCtx): PaletteCommand => {
  const title = labelOf(a, ctx)
  const step = valueSteps(a)[0]
  const parse = a.parse
  return {
    id: a.id,
    action: a.id,
    title,
    subtitle: a.subtitle?.(ctx),
    group: a.group ?? 'commands',
    icon: a.icon,
    keywords: title === a.title ? a.keywords : [...(a.keywords ?? []), a.title],
    danger: a.danger,
    name: a.name,
    hint: a.hint,
    keepOpen: a.keepOpen,
    slash: a.slash,
    parse: step && parse && (text => guardAction(a, () => parse(text), null)),
    arg: step && argOf(step, ctx),
    run: arg => confirmThenRun(a, ctx, step && arg !== undefined ? { [step.name]: arg } : {}),
  }
}

export const paletteCommands = (ctx: ActionCtx): PaletteCommand[] =>
  allActions().flatMap(a =>
    isAvailable(a, ctx)
      ? guardAction(a, () => (askable(a, ctx) ? [paletteRow(a, ctx)] : []), [])
      : []
  )
