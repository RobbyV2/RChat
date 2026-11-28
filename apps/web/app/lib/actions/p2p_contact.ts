// A P2P contact's menu: on the P2P page, in the contact's dialog and on Home's P2P card.

import { Ban, Bell, BellOff, Lock, MessageCircle, Pencil, ShieldCheck, Trash2 } from 'lucide-react'
import {
  EARLIER_ACTION,
  EARLIER_CONFIRM,
  SEAL_LABEL,
  p2pSeal,
  sealReasonText,
  storeRegister,
} from '../sealing'
import { muteEnd, mutedText, type NotifyScope } from '../notify'

import { displayName, type Contact } from '../p2p/contacts'
import { dmRoomId } from '../p2p/dm'
import { openActionMenu } from './menu'
import { muteStep, muteUntil, notifySettings } from './notify'
import type { Action, ActionCtx } from './types'
import { identityActions } from './identity'
import { time } from '../platform/time'
import { unnamed } from '../names'
export const peerContact = identityActions(identity => {
  // The contact as it is now; none once it is gone.
  const contactOf = ({ target }: ActionCtx): Contact | null =>
    target.kind === 'p2p_contact'
      ? (identity()
          .useP2p.getState()
          .contacts.find(c => c.ik === target.c.ik) ?? null)
      : null

  const mutual = (ctx: ActionCtx) => {
    const c = contactOf(ctx)
    return c?.state === 'mutual' ? c : null
  }

  const unblocked = (ctx: ActionCtx) => {
    const c = contactOf(ctx)
    return c && c.state !== 'blocked' ? c : null
  }

  // The DM's notifications, for a mutual contact of an account with a P2P key.
  const dmScope = (ctx: ActionCtx): NotifyScope | null => {
    const c = mutual(ctx)
    const me = ctx.target.kind === 'p2p_contact' ? ctx.target.me : null
    return c && me ? { kind: 'p2p', room: dmRoomId(me, c.ik) } : null
  }

  const mutedUntil = (ctx: ActionCtx) => {
    const scope = dmScope(ctx)
    return scope ? muteEnd(ctx.s.notifyPrefs, scope, time().now()) : null
  }

  const asked = (verb: string, c: Contact, acct = identity().owner) =>
    `${verb} ${acct.store.getState().streamer ? 'this contact' : displayName(c)}?`

  const onContact = { scope: 'p2p', targets: ['p2p_contact'] } as const

  // The conversation with a mutual contact and its "Encrypt stored messages".
  const dmSeal = (ctx: ActionCtx) => {
    const c = mutual(ctx)
    const me = ctx.target.kind === 'p2p_contact' ? ctx.target.me : null
    if (!c || !me) return null
    const room = dmRoomId(me, c.ik)
    const p2p = identity().useP2p.getState()
    const store = p2p.rooms[room]?.store
    const state = p2pSeal({
      store,
      siteForced: p2p.seal.everything,
      deviceKey: p2p.seal.available,
      allowed: true,
    })
    return { room, state, shared: storeRegister(store).on }
  }

  const sealActions: Action[] = [
    {
      id: 'p2p_dm_seal',
      title: SEAL_LABEL,
      icon: Lock,
      ...onContact,
      order: 600,
      keywords: ['encrypt', 'storage'],
      available: ctx => dmSeal(ctx) !== null,
      checked: ctx => dmSeal(ctx)?.state.on ?? false,
      disabled: ctx => !(dmSeal(ctx)?.state.available ?? false),
      subtitle: ctx => {
        const seal = dmSeal(ctx)
        return (seal && sealReasonText(seal.state, 'p2p')) ?? undefined
      },
      run: ctx => {
        const seal = dmSeal(ctx)
        if (seal?.state.available) void identity().p2pDm.setStore(seal.room, !seal.state.on)
      },
    },
    {
      id: 'p2p_dm_seal_earlier',
      title: EARLIER_ACTION,
      icon: Lock,
      ...onContact,
      order: 610,
      keywords: ['encrypt', 'storage'],
      available: ctx => dmSeal(ctx)?.state.on ?? false,
      run: ctx => {
        const seal = dmSeal(ctx)
        if (!seal) return
        identity()
          .owner.store.getState()
          .askConfirm({
            title: EARLIER_ACTION,
            body: EARLIER_CONFIRM,
            confirm: 'Encrypt',
            action: () =>
              seal.shared
                ? void identity().p2pDm.setStore(seal.room, true, true)
                : identity().p2pDm.sealEarlierHere(seal.room),
          })
      },
    },
  ]

  const p2pContactActions: Action[] = [
    {
      id: 'p2p_contact_message',
      title: 'Message',
      icon: MessageCircle,
      ...onContact,
      order: 100,
      available: ctx => mutual(ctx) !== null,
      run: ctx => {
        const c = mutual(ctx)
        if (c) void identity().p2pDm.openDm(c.ik)
      },
    },
    {
      id: 'p2p_contact_mute',
      title: 'Mute DM',
      icon: BellOff,
      ...onContact,
      order: 120,
      args: [muteStep],
      available: ctx => dmScope(ctx) !== null && mutedUntil(ctx) === null,
      run: (ctx, { value }) => {
        const scope = dmScope(ctx)
        if (scope) ctx.acct.store.getState().muteScope(scope, muteUntil(value))
      },
    },
    {
      id: 'p2p_contact_unmute',
      title: 'Unmute DM',
      icon: Bell,
      ...onContact,
      order: 120,
      subtitle: ctx => {
        const end = mutedUntil(ctx)
        return end === null ? undefined : mutedText(end, time().now())
      },
      available: ctx => mutedUntil(ctx) !== null,
      run: ctx => {
        const scope = dmScope(ctx)
        if (scope) ctx.acct.store.getState().muteScope(scope, null)
      },
    },
    notifySettings('p2p_contact_notify', 'p2p', ['p2p_contact'], dmScope),
    {
      id: 'p2p_contact_rename',
      title: 'Rename',
      icon: Pencil,
      ...onContact,
      order: 300,
      available: ctx => unblocked(ctx) !== null,
      run: ctx => {
        const c = unblocked(ctx)
        if (c) identity().p2p.openDialog({ kind: 'rename', ik: c.ik })
      },
    },
    {
      id: 'p2p_contact_verify',
      title: 'Verify',
      icon: ShieldCheck,
      ...onContact,
      order: 310,
      available: ctx => unblocked(ctx) !== null,
      run: ctx => {
        const c = unblocked(ctx)
        if (c) identity().p2p.openDialog({ kind: 'verify', ik: c.ik })
      },
    },
    {
      id: 'p2p_contact_block',
      title: 'Block',
      icon: Ban,
      danger: true,
      ...onContact,
      order: 800,
      available: ctx => unblocked(ctx) !== null,
      run: ctx => {
        const c = unblocked(ctx)
        if (!c) return
        ctx.acct.store.getState().askConfirm({
          title: asked('Block', c, ctx.acct),
          body: 'They can no longer reach you over P2P. You can remove the block later.',
          confirm: 'Block',
          action: identity().inIdentity(() => void identity().p2p.block(c.ik)),
        })
      },
    },
    {
      id: 'p2p_contact_remove',
      title: 'Remove',
      icon: Trash2,
      ...onContact,
      order: 810,
      label: ctx => unnamed(contactOf(ctx)?.state === 'blocked' ? 'Remove block' : 'Remove'),
      dangerFor: ctx => contactOf(ctx)?.state !== 'blocked',
      available: ctx => contactOf(ctx) !== null,
      run: ctx => {
        const c = contactOf(ctx)
        if (!c) return
        if (c.state === 'blocked') {
          void identity().p2p.remove(c.ik)
          return
        }
        ctx.acct.store.getState().askConfirm({
          title: asked('Remove', c, ctx.acct),
          body: 'They stay able to send you a new request.',
          confirm: 'Remove',
          action: identity().inIdentity(() => void identity().p2p.remove(c.ik)),
        })
      },
    },
  ]

  const openContactMenu = (
    x: number,
    y: number,
    c: Contact,
    me: string | null,
    acct = identity().owner
  ) => openActionMenu(x, y, { kind: 'p2p_contact', c, me }, undefined, acct, identity())

  return { actions: [...p2pContactActions, ...sealActions], openContactMenu }
})
export const p2pContactActions = peerContact.actions
