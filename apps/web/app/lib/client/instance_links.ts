import { deepLinkTarget } from '../deep_links'
import { localOrigins, ownInstance, readLocal, writeLocal } from '../instances'
import { parseInvite, parseInviteAt, safeNext } from '../invite'
import { hostOf } from '../qualified'
import { accountPath, parseAccountPath, parsePath } from '../view'
import { accountHistoryState, routeOwnerFor, resolvePageAccount } from './account_paths'
import { canAddInstance } from './adding'
import { client } from './client'
import { accountStorage } from './keys'
import { openAccountNotice } from './notice_owner'
import { createSavedSession, savedConnection } from './saved_session'
import { selectLinkOwner } from './link_selection'
import type { AccountSession } from './session'
import { switcherSession } from './switch_actor'

export interface InstanceTarget {
  origin: string
  path: string
}
export interface InstanceLinkDialog {
  kind: 'instance_link'
  target: InstanceTarget
  users: string[]
  selected?: string
  username?: string
  accept: (account: string | AccountSession, remember?: boolean) => void
}

export function knownLinkOrigin(origin: string) {
  return client.book.getState().instances.some(i => i.origin === origin)
}

// Ordinary web URLs become app actions only for a recognized instance and route.
export function messageInstanceTarget(owner: AccountSession, href: string): InstanceTarget | null {
  if (href.startsWith('rchat:')) {
    const target = deepLinkTarget(href, owner.conn.origin)
    return (
      target && {
        origin: target.kind === 'home' ? owner.conn.origin : target.origin,
        path: target.path,
      }
    )
  }
  if (!/^https?:\/\//i.test(href) && !href.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(href, owner.shareOrigin)
  } catch {
    return null
  }
  if (url.username || url.password || !/^https?:$/.test(url.protocol)) return null
  const path = url.pathname + url.search + url.hash
  const route = parseAccountPath(path)
  if (!route || (!parseInvite(route.path, url.origin) && parsePath(route.path)?.kind !== 'message'))
    return null
  if (knownLinkOrigin(url.origin)) return { origin: url.origin, path }
  return localOrigins(owner.conn).includes(url.origin) ? { origin: owner.conn.origin, path } : null
}

// Submitting an invite to Join is an explicit request to contact its instance.
export function submittedLinkTarget(owner: AccountSession, href: string) {
  const target = messageInstanceTarget(owner, href)
  if (target) return target
  const invite = parseInviteAt(href, owner.shareOrigin)
  return invite && { origin: invite.origin, path: invite.url.slice(invite.origin.length) }
}

const preference = (origin: string) => 'rchat_link_account@' + origin

function eligibleUsers(origin: string) {
  const group = client.book.getState().instances.find(i => i.origin === origin)
  const users = new Set<string>()
  for (const a of client.live()) {
    const { me, signedOut, authExpired } = a.store.getState()
    if (a.conn.origin === origin && me && !signedOut && !authExpired) users.add(me.username)
  }
  if (group) {
    const keys = accountStorage(savedConnection(origin))
    for (const a of group.accounts) {
      const live = switcherSession({ origin, username: a.username })?.store.getState()
      if (!live?.authExpired && !live?.signedOut && readLocal(keys.token(a.username)))
        users.add(a.username)
    }
  }
  return [...users]
}

export function linkChoice(source: AccountSession, origin: string) {
  const users = eligibleUsers(origin)
  const choice = selectLinkOwner(
    users,
    readLocal(preference(origin)) ?? undefined,
    source.conn.origin === origin ? source.store.getState().me?.username : undefined,
    username => {
      const account = switcherSession({ origin, username })
      return account ? client.accounts.lastShown(account) : 0
    }
  )
  return { users, choice }
}

async function openTarget(owner: AccountSession, target: InstanceTarget) {
  const state = owner.store.getState()
  const invite = parseInvite(target.path, target.origin)
  const route = parsePath(target.path)
  const page = accountPath(target.path, routeOwnerFor(owner))
  if (typeof window !== 'undefined' && /^\/login\/?$/.test(window.location.pathname)) {
    window.history.pushState(accountHistoryState(owner, null), '', page)
    window.location.reload()
    return
  }
  // A refused viewing prompt leaves the previous P2P view intact.
  const peer = owner.identities.coversView() ? owner.identities.viewed() : null
  const off =
    peer &&
    owner.store.subscribe((s, prev) => {
      if (
        owner.identities.viewed() === peer &&
        client.shown() === owner &&
        (s.view !== prev.view ||
          s.invite !== prev.invite ||
          s.adminPage !== prev.adminPage ||
          s.configLink !== prev.configLink)
      )
        peer.p2p.closeHome()
    })
  try {
    await openAccountNotice(owner, () => {
      if (invite) return state.openInvite(invite.server, invite.password, invite.code, target.path)
      switch (route?.kind) {
        case 'message':
          return state.openMessage(route.id, 'push', route.place, route.thread)
        case 'channel':
          return state.openChannel(route.server, route.channelId)
        case 'server':
          return state.openServer(route.server)
        case 'dm': {
          const mark = owner.lifetime.sessionMark()
          const nav = owner.store.navigationMark()
          return owner.store.canOpenDm(route.dmId).then(ok => {
            if (
              ok &&
              client.shown() === owner &&
              mark === owner.lifetime.sessionMark() &&
              nav === owner.store.navigationMark()
            )
              return state.openDm(route.dmId)
          })
        }
        case 'admin':
          return state.me?.is_site_admin
            ? state.openAdmin(
                route.section,
                route.item,
                new URL(target.path, target.origin).hash.slice(1) || null
              )
            : false
      }
      if (target.path === '/') {
        peer?.p2p.closeHome()
        return state.goHome()
      }
      window.history.pushState(accountHistoryState(owner, null), '', page)
      client.commitNotice(owner)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
  } finally {
    off?.()
  }
}

// A chooser or login can outlive its click. Recheck the source, navigation intent and
// destination credential before the transactional hand-off.
export async function routeInstanceLink(
  source: AccountSession,
  target: InstanceTarget,
  selectedAs: AccountSession | null = null
) {
  if (client.shown() !== source || !safeNext(target.path)) return
  const route = parseAccountPath(target.path)
  if (!route) return
  let { origin } = target
  const explicit = route.owner?.username
  if (route.owner && route.owner.host !== hostOf(origin)) {
    if (origin !== ownInstance()?.origin) return
    const account = resolvePageAccount(target.path, null)
    if (!account) return source.store.getState().setError('This account is unavailable.')
    origin = account.conn.origin
  }
  if (!canAddInstance() && origin !== ownInstance()?.origin)
    return source.store.getState().setError("This site's app only connects to its own instance.")
  const destination = { origin, path: route.path }
  source.store.cancelNavigation()
  const mark = source.lifetime.sessionMark()
  const nav = source.store.navigationMark()
  const shown = client.shownVersion()
  const current = () =>
    client.shown() === source &&
    client.live().includes(source) &&
    client.shownVersion() === shown &&
    mark === source.lifetime.sessionMark() &&
    nav === source.store.navigationMark()
  const { users, choice } = linkChoice(selectedAs ?? source, origin)
  function sessionFor(username: string | null) {
    if (
      source.conn.origin === origin &&
      (source.store.getState().me?.username ??
        (source.store.getState().guest ? null : source.credentialTarget)) === username
    )
      return source
    return switcherSession({ origin, username }) ?? createSavedSession(origin, username)
  }
  const accept = async (selected: string | AccountSession, remember = false) => {
    if (!current()) return
    if (typeof selected === 'string' && !eligibleUsers(origin).includes(selected))
      return source.store.getState().setError('Sign in again to open this link.')
    const owner = typeof selected === 'string' ? sessionFor(selected) : selected
    const expected = typeof selected === 'string' ? selected : explicit
    if (owner.conn.origin !== origin) return
    const before = owner.lifetime.sessionMark()
    if (!owner.store.getState().me && !owner.store.getState().guest)
      await owner.store.getState().bootstrap(false)
    const { me, guest, authExpired, signedOut } = owner.store.getState()
    if (!current() || !client.live().includes(owner)) return
    if (
      before !== owner.lifetime.sessionMark() ||
      authExpired ||
      signedOut ||
      (!me && (!guest || !owner.store.getState().settings.guests_enabled)) ||
      (expected !== undefined && (me?.username ?? null) !== expected)
    )
      return source.store.getState().setError('Sign in again to open this link.')
    if (remember && me) writeLocal(preference(origin), me.username)
    await openTarget(owner, destination)
  }
  if (explicit !== undefined) {
    if (explicit !== null && users.includes(explicit)) return accept(explicit)
    if (explicit === null) {
      const keys = accountStorage(savedConnection(origin))
      if (readLocal(keys.key('rchat_guest')) === '1') return accept(sessionFor(null))
      return source.store.getState().setError('This guest account is unavailable.')
    }
  } else if (selectedAs?.conn.origin === origin) {
    if (!selectedAs.store.getState().me && !selectedAs.store.getState().guest)
      return source.store.getState().setError('Sign in again to open this link.')
    return accept(selectedAs)
  } else if (choice.kind === 'open') return accept(choice.owner)

  const marks = new Map(
    users.map(username => {
      const owner = switcherSession({ origin, username })
      return [username, owner?.lifetime.sessionMark()] as const
    })
  )
  const result = await new Promise<{ account: string | AccountSession; remember?: boolean } | null>(
    resolve => {
      const dialog: InstanceLinkDialog = {
        kind: 'instance_link',
        target: destination,
        users: explicit === undefined ? users : [],
        username: explicit ?? undefined,
        selected: explicit === undefined && choice.kind === 'choose' ? choice.owner : undefined,
        accept: (account, remember) => {
          if (source.store.getState().activeDialog === dialog) finish({ account, remember })
        },
      }
      function finish(value: { account: string | AccountSession; remember?: boolean } | null) {
        offStore()
        offClient()
        if (source.store.getState().activeDialog === dialog) source.store.getState().closeDialog()
        resolve(value)
      }
      function check() {
        if (!current() || source.store.getState().activeDialog !== dialog) finish(null)
      }
      const offStore = source.store.subscribe(check)
      const offClient = client.subscribe(check)
      source.store.getState().openDialog(dialog)
    }
  )
  if (!result || !current()) return
  if (typeof result.account === 'string') {
    const mark = marks.get(result.account)
    if (
      mark &&
      mark !== switcherSession({ origin, username: result.account })?.lifetime.sessionMark()
    )
      return source.store.getState().setError('Sign in again to open this link.')
  }
  await accept(result.account, result.remember)
}
