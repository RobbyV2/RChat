import { CANT_TEXT } from '../flows'
import { can, P } from '../state'
import { storeRegister } from '../../sealing'
import type { ServerCtx } from './context'
import { ServerError } from './types'

// Whether this device stores the room's events sealed follows the room's `store` register: from
// the moment a change is admitted here, every event stored after it takes the new form. A device
// that can't keep a device key stores plain.
export async function followStore(cx: ServerCtx, room: string) {
  const { on } = storeRegister(cx.sumOf(room).store)
  await cx.deps.store.sealing.setRoom(room, on).catch(() => {})
}

// Turns "Encrypt stored messages" of a room on or off (`store`). An owner or a member with
// Manage server may. Fields of the register this version doesn't know stay as they are.
export async function setStore(cx: ServerCtx, room: string, on: boolean, earlier = false) {
  // Admitted by the generic rule: one we may not make would show nothing.
  const s = cx.sumOf(room)
  if (!can(s, cx.me, P.ManageServer)) throw new ServerError(CANT_TEXT)
  return cx.emit(room, 'store', () => {
    const kept: Record<string, unknown> = { ...(s.store ?? {}) }
    delete kept.earlier
    return { ...kept, on, ...(on && earlier ? { earlier: true } : {}) }
  })
}
