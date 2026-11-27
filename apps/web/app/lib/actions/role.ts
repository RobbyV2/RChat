import { stepRole } from '../hierarchy'
import type { Action, ActionCtx } from './types'

// A server's role rows: move a role one step among the roles you may move, in the role order or
// in the order roles show in.
const stepOf = ({ target }: ActionCtx, step: -1 | 1) =>
  target.kind === 'role' ? stepRole(target.order, target.movable, target.role.id, step) : null

const shownStepOf = ({ target }: ActionCtx, step: -1 | 1) =>
  target.kind === 'role' ? stepRole(target.display, target.movable, target.role.id, step) : null

const move = (step: -1 | 1) => (ctx: ActionCtx) => {
  const { target } = ctx
  const order = stepOf(ctx, step)
  if (target.kind !== 'role' || !order) return
  void ctx.acct.store
    .getState()
    .setRoleOrder(target.server, order, target.version)
    .then(ctx.acct.lifetime.inSession(() => target.after?.()))
}

const show = (order: (ctx: ActionCtx) => number[] | null) => (ctx: ActionCtx) => {
  const { target } = ctx
  if (target.kind !== 'role') return
  const next = order(ctx)
  void ctx.acct.store
    .getState()
    .setRoleDisplay(target.server, next, target.version)
    .then(ctx.acct.lifetime.inSession(() => target.after?.()))
}

// Showing roles in role order again moves every role whose place changes: all must be movable.
const mayFollow = ({ target }: ActionCtx) =>
  target.kind === 'role' &&
  !target.follows &&
  target.order.every((id, i) => target.display[i] === id || target.movable.includes(id))

const onRole = { scope: 'server', targets: ['role'] } as const

export const roleActions: Action[] = [
  {
    id: 'role_up',
    title: 'Move Up',
    ...onRole,
    order: 100,
    available: ctx => stepOf(ctx, -1) !== null,
    run: move(-1),
  },
  {
    id: 'role_down',
    title: 'Move Down',
    ...onRole,
    order: 110,
    available: ctx => stepOf(ctx, 1) !== null,
    run: move(1),
  },
  {
    id: 'role_show_up',
    title: 'Show Higher',
    subtitle: () => 'In the member list',
    ...onRole,
    order: 120,
    available: ctx => shownStepOf(ctx, -1) !== null,
    run: show(ctx => shownStepOf(ctx, -1)),
  },
  {
    id: 'role_show_down',
    title: 'Show Lower',
    subtitle: () => 'In the member list',
    ...onRole,
    order: 130,
    available: ctx => shownStepOf(ctx, 1) !== null,
    run: show(ctx => shownStepOf(ctx, 1)),
  },
  {
    id: 'role_show_ranked',
    title: 'Show in Role Order',
    ...onRole,
    order: 140,
    available: mayFollow,
    run: show(() => null),
  },
]
