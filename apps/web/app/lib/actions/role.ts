import { stepRole } from '../hierarchy'
import type { Action, ActionCtx } from './types'

// A server's role rows: move a role one step among the roles you may move.
const stepOf = ({ target }: ActionCtx, step: -1 | 1) =>
  target.kind === 'role' ? stepRole(target.order, target.movable, target.role.id, step) : null

const move = (step: -1 | 1) => (ctx: ActionCtx) => {
  const { target } = ctx
  const order = stepOf(ctx, step)
  if (target.kind !== 'role' || !order) return
  void ctx.acct.store
    .getState()
    .setRoleOrder(target.server, order, target.version)
    .then(ctx.acct.lifetime.inSession(() => target.after?.()))
}

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
]
