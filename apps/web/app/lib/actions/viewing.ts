import {
  canView,
  forgetViewing,
  markPersonally,
  needsWarning,
  personallyMarked,
  type ViewingTarget,
} from '../viewing'
import type { Action, ActionCtx, Target } from './types'

// Instance and peer channel menus use the same local choices.
export const viewingActions = (
  kind: Extract<Target['kind'], 'channel' | 'p2p_channel'>,
  target: (ctx: ActionCtx) => ViewingTarget | null,
  manages: (ctx: ActionCtx) => boolean,
  label: (ctx: ActionCtx, sensitive: boolean) => void
): Action[] => {
  const at = { scope: kind === 'channel' ? 'channel' : 'p2p', targets: [kind], order: 880 } as const
  return [
    {
      ...at,
      id: kind + '_personal_label',
      title: 'Mark sensitive on this device',
      available: ctx => !!target(ctx),
      checked: ctx => {
        const t = target(ctx)
        return !!t && personallyMarked(t)
      },
      run: ctx => {
        const t = target(ctx)
        if (t) markPersonally(t, !personallyMarked(t))
      },
    },
    {
      ...at,
      id: kind + '_hide_content',
      title: 'Hide channel again',
      available: ctx => {
        const t = target(ctx)
        return !!t && needsWarning(t) && canView(t)
      },
      run: ctx => {
        const t = target(ctx)
        if (t) forgetViewing(t)
      },
    },
    {
      ...at,
      id: kind + '_shared_label',
      title: 'Mark sensitive for everyone',
      available: ctx => !!target(ctx) && manages(ctx),
      checked: ctx => target(ctx)?.sensitive === true,
      run: ctx => {
        const t = target(ctx)
        if (t && manages(ctx)) label(ctx, !t.sensitive)
      },
    },
  ]
}
