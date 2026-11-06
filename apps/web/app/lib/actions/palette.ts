import type { ArgSpec, PaletteCommand } from '../palette'
import { allActions, guardAction, isAvailable, labelOf } from './registry'
import {
  askable,
  confirmThenRun,
  expansionsOf,
  iconOf,
  runExpansion,
  valueSteps,
  type ValueStep,
} from './steps'
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
    icon: iconOf(a, ctx),
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

const expansionRows = (a: Action, ctx: ActionCtx): PaletteCommand[] =>
  expansionsOf(a, ctx).map(x => ({
    id: `${a.id}_${x.key}`,
    action: a.id,
    title: x.label,
    subtitle: x.subtitle,
    subtitleName: x.subtitleName,
    group: a.group ?? 'commands',
    icon: x.icon ?? iconOf(a, ctx),
    keywords: a.keywords,
    danger: x.danger ?? a.danger,
    name: x.name,
    keepOpen: a.keepOpen,
    run: () => runExpansion(a, ctx, x.key),
  }))

const rowsOf = (a: Action, ctx: ActionCtx): PaletteCommand[] =>
  a.expand ? expansionRows(a, ctx) : askable(a, ctx) ? [paletteRow(a, ctx)] : []

// In registration order; a row id that is already taken keeps its first row.
export const paletteCommands = (ctx: ActionCtx): PaletteCommand[] => {
  const seen = new Set<string>()
  return allActions()
    .flatMap(a => (isAvailable(a, ctx) ? guardAction(a, () => rowsOf(a, ctx), []) : []))
    .filter(r => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })
}
