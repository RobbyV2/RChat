// "Send join and leave messages here" on a text channel of a hosted server or a P2P room, for
// whoever may change the place's join and leave message settings.

import { systemMessagesOf, type SystemPlace } from '../place/system_messages'
import { errorText } from '../store'
import { SYSTEM_HERE_DONE, SYSTEM_HERE_TITLE } from '../system_messages'
import type { Action, ActionCtx, Scope, Target } from './types'

// The channel a menu is on: its place, its key there, and whether it holds text.
export interface SystemChannelAt {
  place: SystemPlace
  channel: number | string
  text: boolean
}

const editorAt = (at: SystemChannelAt | null) =>
  at?.text ? systemMessagesOf(at.place).editor.get() : null

export const systemChannelAction = (
  id: string,
  scope: Scope,
  targets: readonly Target['kind'][],
  order: number,
  of: (ctx: ActionCtx) => SystemChannelAt | null
): Action => ({
  id,
  title: SYSTEM_HERE_TITLE,
  scope,
  targets,
  order,
  available: ctx => editorAt(of(ctx)) !== null,
  run: async ctx => {
    const at = of(ctx)
    const editor = editorAt(at)
    if (!at || !editor) return
    const { store } = at.place.account
    await editor.save({ channel: String(at.channel) }).then(
      () => store.getState().showToast(SYSTEM_HERE_DONE),
      (err: unknown) => store.getState().setError(errorText(err))
    )
  },
})
