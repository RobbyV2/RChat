import { readLocal, setMediaCookie, writeLocal } from '../instances'
import {
  moveInstance,
  moveAccount,
  moveIdentity,
  setGuest,
  type Book,
  type BookAccount,
} from './book'
import { client } from './client'
import { forgetCredential } from './credentials'
import { requestBadge, requestBadgePrefix } from './request_badge'
import { accountStorage } from './keys'
import { createSavedSession, savedConnection } from './saved_session'
import type { AccountSession } from './session'

type Status = 'Online' | 'Appear offline' | 'Connecting' | 'Paused' | 'Signed out' | 'Read only'

interface Actor {
  origin: string
  username: string | null
  local: string | null
}

export type OrderTarget = { origin: string; username?: string; local?: string }

export function moveSwitcherRow(book: Book, from: OrderTarget, to: OrderTarget) {
  if (from.username === undefined) {
    const index = book.instances.findIndex(i => i.origin === to.origin)
    return index < 0 ? book : moveInstance(book, from.origin, index)
  }
  const accounts = book.instances.find(i => i.origin === from.origin)?.accounts
  if (from.local === undefined) {
    const index = accounts?.findIndex(a => a.username === to.username) ?? -1
    return index < 0 ? book : moveAccount(book, from.origin, from.username, index)
  }
  const index =
    accounts
      ?.find(a => a.username === from.username)
      ?.identities.findIndex(i => i.local === to.local) ?? -1
  return index < 0 ? book : moveIdentity(book, from.origin, from.username, from.local, index)
}

export interface SwitcherRow extends Actor {
  saved: boolean
  display: string
  status: Status
  badge: number
  unread: boolean
  active: boolean
  avatar: BookAccount['avatar']
  ik: string | null
  background: boolean
}

interface Snapshot extends Actor {
  display?: string
  status: Status
  badge: number
  unread: boolean
  ik?: string | null
}

const keyOf = ({ origin, username, local }: Actor) => JSON.stringify([origin, username, local])

export function switcherRows(book: Book, snapshots: readonly Snapshot[], actor: Actor | null) {
  const current = new Map(snapshots.map(row => [keyOf(row), row]))
  const selected = actor && keyOf(actor)
  let otherBadge = 0
  const groups = book.instances
    .filter(i => i.accounts.length || i.guest)
    .map(instance => {
      const rows: SwitcherRow[] = []
      const add = (
        username: string | null,
        local: string | null,
        display: string,
        status: Status,
        background: boolean,
        avatar: BookAccount['avatar'],
        ik: string | null,
        saved = true
      ) => {
        const id = { origin: instance.origin, username, local }
        const key = keyOf(id)
        const live = current.get(key)
        const active = selected === key
        const badge = live?.badge ?? 0
        if (!active) otherBadge += badge
        rows.push({
          ...id,
          active,
          saved,
          display: live?.display || display,
          status: live?.status ?? status,
          avatar,
          ik: live?.ik ?? ik,
          badge,
          unread: live?.unread ?? false,
          background,
        })
      }
      for (const account of instance.accounts) {
        const user = account.username
        add(
          user,
          null,
          account.display || user,
          'Signed out',
          account.connect,
          account.avatar,
          null
        )
        const peerStatus = rows[rows.length - 1].status === 'Signed out' ? 'Signed out' : 'Paused'
        const saved = new Set(account.identities.map(id => id.local))
        for (const id of account.identities)
          add(user, id.local, id.name, peerStatus, id.background, null, id.ik)
        for (const peer of snapshots) {
          if (
            peer.origin === instance.origin &&
            peer.username === user &&
            peer.local &&
            !saved.has(peer.local)
          )
            add(
              user,
              peer.local,
              peer.display || peer.local,
              peer.status,
              true,
              null,
              peer.ik ?? null,
              false
            )
        }
      }
      if (instance.guest) add(null, null, 'Guest', 'Read only', false, null, null)
      return {
        origin: instance.origin,
        host: new URL(instance.origin).host,
        name: instance.name,
        rows,
      }
    })
  return { groups, otherBadge }
}

function ownerName(account: AccountSession) {
  const state = account.store.getState()
  return state.me?.username ?? (state.guest ? null : account.credentialTarget)
}

export function liveSwitcherRows() {
  const shown = client.shown()
  const book = client.book.getState()
  const snapshots: Snapshot[] = []
  let actor: Actor | null = null
  const live = client.live()
  for (const instance of book.instances) {
    const siblings = live.filter(a => a.conn.origin === instance.origin)
    const conn = siblings[0]?.conn ?? savedConnection(instance.origin)
    const keys = accountStorage(conn)
    for (const entry of instance.accounts) {
      const username = entry.username
      const a =
        siblings.find(s => ownerName(s) === username && s === shown) ??
        siblings.find(s => ownerName(s) === username)
      const st = a?.store.getState()
      const id = { origin: instance.origin, username }
      const local = a?.identities.coversView() ? (a.identities.viewed()?.localId ?? null) : null
      if (a === shown) actor = { ...id, local }
      const authenticated = !!st?.token || !!readLocal(keys.token(username))
      if (!authenticated) continue
      const paused = !a || a.mode === 'parked' || !a.socketAllowed
      const counts = a?.counts.breakdown()
      const apps = a?.identities.list() ?? []
      for (const app of apps) {
        const peer = app.useP2p.getState()
        const saved = entry.identities.some(i => i.local === app.localId)
        if (!peer.enabled && !saved) continue
        const pings = counts?.peers[app.localId] ?? 0
        const requests = requestBadge(instance.origin, username, app.localId, peer)
        snapshots.push({
          ...id,
          local: app.localId,
          display: peer.name || undefined,
          ik: peer.ik,
          status:
            peer.status === 'online'
              ? 'Online'
              : peer.status === 'starting' || peer.status === 'connecting'
                ? 'Connecting'
                : 'Paused',
          badge: pings + requests,
          unread:
            Object.values(peer.rooms).some(r => r.unread > 0) ||
            Object.values(peer.servers).some(s => Object.values(s.chans).some(c => c.unread > 0)),
        })
      }
      for (const saved of entry.identities) {
        if (apps.some(app => app.localId === saved.local)) continue
        const badge =
          (counts?.peers[saved.local] ?? 0) + requestBadge(instance.origin, username, saved.local)
        if (badge)
          snapshots.push({
            ...id,
            local: saved.local,
            status: 'Paused',
            badge,
            unread: false,
          })
      }
      snapshots.push({
        ...id,
        local: null,
        display: st?.me?.display_name || undefined,
        status: paused
          ? 'Paused'
          : !st?.me || st.wsStatus !== 'green'
            ? 'Connecting'
            : st.me.appear_offline
              ? 'Appear offline'
              : 'Online',
        badge: counts?.instance ?? 0,
        unread: (counts?.unread ?? 0) > 0,
      })
    }
    if (instance.guest && shown.conn.origin === instance.origin && shown.store.getState().guest)
      actor = { origin: instance.origin, username: null, local: null }
  }
  return switcherRows(book, snapshots, actor)
}

export function createSwitcherSource() {
  let snapshot = liveSwitcherRows()
  let encoded = JSON.stringify(snapshot)
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      const refresh = () => {
        const next = liveSwitcherRows()
        const value = JSON.stringify(next)
        if (encoded === value) return
        snapshot = next
        encoded = value
        notify()
      }
      let detach: (() => void)[] = []
      let queued = false
      let active = true
      // The registry iterates its live listener set while announcing a change.
      const scheduleBind = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          if (active) bind()
        })
      }
      const bind = () => {
        for (const off of detach) off()
        detach = []
        for (const a of client.live()) {
          detach.push(
            a.identities.subscribe(scheduleBind),
            a.counts.subscribe(refresh),
            a.store.subscribe((s, p) => {
              if (
                s.me !== p.me ||
                s.guest !== p.guest ||
                s.token !== p.token ||
                s.reads !== p.reads ||
                s.wsStatus !== p.wsStatus ||
                s.notifyPrefs !== p.notifyPrefs
              )
                refresh()
            })
          )
          for (const app of a.identities.list())
            detach.push(
              app.useP2p.subscribe((s, p) => {
                if (
                  s.status !== p.status ||
                  s.home !== p.home ||
                  s.dmList !== p.dmList ||
                  s.server !== p.server ||
                  s.chat !== p.chat ||
                  s.name !== p.name ||
                  s.ik !== p.ik ||
                  s.rooms !== p.rooms ||
                  s.servers !== p.servers ||
                  s.contacts !== p.contacts
                )
                  refresh()
              })
            )
        }
        refresh()
      }
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key.startsWith(requestBadgePrefix)) refresh()
      }
      window.addEventListener('storage', onStorage)
      const offClient = client.subscribe(scheduleBind)
      const offBook = client.book.subscribe(refresh)
      bind()
      return () => {
        active = false
        window.removeEventListener('storage', onStorage)
        offBook()
        offClient()
        for (const off of detach) off()
      }
    },
  }
}

export function signOutSwitcherAccount(origin: string, username: string | null) {
  const live = client.live()
  const target = live.find(a => a.conn.origin === origin && ownerName(a) === username)
  const instance = client.book.getState().instances.find(i => i.origin === origin)
  if (
    !instance ||
    (username === null ? !instance.guest : !instance.accounts.some(a => a.username === username))
  )
    return
  const conn = target?.conn ?? savedConnection(origin)
  const state = target?.store.getState()
  if (target === client.shown()) {
    let survivor = live.find(
      a => a !== target && (a.store.getState().token || a.store.getState().guest)
    )
    // A parked account may not have opened its socket or loaded /me in this tab.
    for (const instance of client.book.getState().instances) {
      if (survivor) break
      const connection =
        live.find(a => a.conn.origin === instance.origin)?.conn ?? savedConnection(instance.origin)
      const keys = accountStorage(connection)
      const named = instance.accounts.find(
        a =>
          !(instance.origin === origin && a.username === username) &&
          readLocal(keys.token(a.username))
      )
      const guest =
        instance.guest &&
        !(instance.origin === origin && username === null) &&
        readLocal(keys.key('rchat_guest')) === '1'
      if (!named && !guest) continue
      const user = named?.username ?? null
      survivor =
        live.find(a => a.conn.origin === instance.origin && ownerName(a) === user) ??
        createSavedSession(instance.origin, user)
    }
    if (survivor) {
      client.show(survivor, 'replace')
      if (!survivor.store.getState().me && !survivor.store.getState().guest)
        void survivor.store
          .getState()
          .bootstrap()
          .catch(() => {})
    }
  }
  if (state?.guest || state?.token) {
    state.logout()
  } else if (username !== null) {
    const token = readLocal(accountStorage(conn).token(username))
    if (token) {
      if (forgetCredential(conn, username, token)) setMediaCookie(conn, null)
      void conn.api.logout(token).catch(() => {})
    }
  } else {
    // A saved guest may be parked before its first bootstrap.
    const keys = accountStorage(conn)
    for (const name of [
      'rchat_guest',
      'rchat_guest_grants',
      'rchat_guest_servers',
      'rchat_guest_names',
    ])
      writeLocal(keys.key(name), null)
    void client.updateBook(book => setGuest(book, origin, false))
    target?.store.retireCredentials()
  }
  client.accounts.schedule()
}
