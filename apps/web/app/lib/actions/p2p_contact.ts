// A P2P contact's menu: on the P2P page, in the contact's dialog and on Home's P2P card.

import { Ban, Bell, BellOff, MessageCircle, Pencil, ShieldCheck, Trash2 } from 'lucide-react'
import { muteEnd, mutedText, type NotifyScope } from '../notify'
import { p2p, p2pDm, useP2p } from '../p2p/app'
import { displayName, type Contact } from '../p2p/contacts'
import { dmRoomId } from '../p2p/dm'
import { useStore } from '../store'
import { openActionMenu } from './menu'
import { muteStep, muteUntil, notifySettings } from './notify'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

// The contact as it is now; none once it is gone.
const contactOf = ({ target }: ActionCtx): Contact | null =>
  target.kind === 'p2p_contact'
    ? (useP2p.getState().contacts.find(c => c.ik === target.c.ik) ?? null)
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
  return scope ? muteEnd(ctx.s.notifyPrefs, scope, Date.now()) : null
}

const asked = (verb: string, c: Contact) =>
  `${verb} ${get().streamer ? 'this contact' : displayName(c)}?`

const onContact = { scope: 'p2p', targets: ['p2p_contact'] } as const

export const p2pContactActions: Action[] = [
  {
    id: 'p2p_contact_message',
    title: 'Message',
    icon: MessageCircle,
    ...onContact,
    order: 100,
    available: ctx => mutual(ctx) !== null,
    run: ctx => {
      const c = mutual(ctx)
      if (c) void p2pDm.openDm(c.ik)
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
      if (scope) get().muteScope(scope, muteUntil(value))
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
      return end === null ? undefined : mutedText(end, Date.now())
    },
    available: ctx => mutedUntil(ctx) !== null,
    run: ctx => {
      const scope = dmScope(ctx)
      if (scope) get().muteScope(scope, null)
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
      if (c) p2p.openDialog({ kind: 'rename', ik: c.ik })
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
      if (c) p2p.openDialog({ kind: 'verify', ik: c.ik })
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
      get().askConfirm({
        title: asked('Block', c),
        body: 'They can no longer reach you over P2P. You can remove the block later.',
        confirm: 'Block',
        action: () => void p2p.block(c.ik),
      })
    },
  },
  {
    id: 'p2p_contact_remove',
    title: 'Remove',
    icon: Trash2,
    ...onContact,
    order: 810,
    label: ctx => (contactOf(ctx)?.state === 'blocked' ? 'Remove block' : 'Remove'),
    dangerFor: ctx => contactOf(ctx)?.state !== 'blocked',
    available: ctx => contactOf(ctx) !== null,
    run: ctx => {
      const c = contactOf(ctx)
      if (!c) return
      if (c.state === 'blocked') {
        void p2p.remove(c.ik)
        return
      }
      get().askConfirm({
        title: asked('Remove', c),
        body: 'They stay able to send you a new request.',
        confirm: 'Remove',
        action: () => void p2p.remove(c.ik),
      })
    },
  },
]

export const openContactMenu = (x: number, y: number, c: Contact, me: string | null) =>
  openActionMenu(x, y, { kind: 'p2p_contact', c, me })
