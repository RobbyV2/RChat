import { Hash, KeyRound, Server } from 'lucide-react'
import { parseQuery, rank, type PaletteItem } from '../palette'
import { buildSections, messageItems, type ResultCtx, type Section } from '../palette_results'
import { displayName } from '../p2p/contacts'
import { p2pSourceId } from '../p2p/palette_source'
import type { P2pApp } from '../p2p/app/runtime'
import { maskOf } from '../store'
import { channelTarget } from '../viewing'
import { instanceLabel } from '../instance_label'
import { readLocal, ownInstance } from '../instances'
import { canAddInstance } from './adding'
import { accountStorage } from './keys'
import { client } from './client'
import type { AccountSession } from './session'

interface Target {
  account: AccountSession
  peer?: P2pApp
  label: string
}

function admitted(account: AccountSession, actor: AccountSession) {
  if (!client.live().includes(account)) return false
  if (account === actor) return true
  const s = account.store.getState()
  if (account.mode === 'parked' || !account.socketAllowed) return false
  if (!canAddInstance() && account.conn.origin !== ownInstance()?.origin) return false
  const instance = client.book.getState().instances.find(i => i.origin === account.conn.origin)
  if (!instance) return false
  const keys = accountStorage(account.conn)
  if (s.guest) return instance.guest && readLocal(keys.key('rchat_guest')) === '1'
  const name = s.me?.username
  return (
    !!name &&
    instance.accounts.some(row => row.username === name && row.connect) &&
    !!s.token &&
    readLocal(keys.token(name)) === s.token
  )
}

function paletteTargets(actor: AccountSession): Target[] {
  const book = client.book.getState()
  const owners = [
    actor,
    ...book.instances.flatMap(i => {
      const names: (string | null)[] = i.accounts.map(row => row.username)
      if (i.guest) names.push(null)
      return names.flatMap(name => {
        const owner = client.live().find(a => {
          const s = a.store.getState()
          return (
            a !== actor &&
            a.conn.origin === i.origin &&
            (s.guest ? null : s.me?.username) === name &&
            admitted(a, actor)
          )
        })
        return owner ? [owner] : []
      })
    }),
  ]
  const places = book.instances.map(i => ({ name: i.name, host: new URL(i.origin).host }))
  return owners.flatMap(account => {
    const state = account.store.getState()
    const instance = book.instances.find(i => i.origin === account.conn.origin)
    const label =
      (state.me?.username ?? 'Guest') +
      ' · ' +
      instanceLabel(instance ?? account.conn.info, account.conn.host, places)
    const base: Target = { account, label }
    const rows = instance?.accounts.find(a => a.username === state.me?.username)?.identities ?? []
    const peers = account.identities
      .list()
      .filter(
        app =>
          state.me &&
          !state.guest &&
          state.settings.p2p &&
          app.useP2p.getState().enabled &&
          app.isCurrent()
      )
      .sort((a, b) => {
        const order = (id: string) => {
          const ix = rows.findIndex(r => r.local === id)
          return ix < 0 ? rows.length : ix
        }
        return order(a.localId) - order(b.localId)
      })
      .map(peer => ({
        account,
        peer,
        label:
          (peer.useP2p.getState().name ||
            rows.find(r => r.local === peer.localId)?.name ||
            'Identity') +
          ' · P2P · ' +
          label,
      }))
    const active =
      account === actor && account.identities.coversView()
        ? peers.find(t => t.peer === account.identities.viewed())
        : null
    return active ? [active, base, ...peers.filter(t => t !== active)] : [base, ...peers]
  })
}

function peerSections(peer: P2pApp, text: string, ctx: ResultCtx): Section[] {
  const { mode, q } = parseQuery(text)
  if (!q && mode === 'all') return []
  const st = peer.useP2p.getState()
  const nav: PaletteItem[] = []
  const people: PaletteItem[] = []
  if (mode !== 'channels')
    for (const c of st.contacts) {
      if (c.state !== 'mutual') continue
      people.push({
        id: 'contact_' + c.ik,
        title: displayName(c),
        group: 'people',
        name: true,
        icon: KeyRound,
        run: () => {
          void peer.p2pDm.openDm(c.ik, 'home')
        },
      })
    }
  if (mode !== 'people')
    for (const room of Object.values(st.servers)) {
      if (room.me !== 'join') continue
      nav.push({
        id: 'peer_server_' + room.id,
        title: room.name,
        group: 'navigation',
        name: true,
        icon: Server,
        run: () => {
          void peer.p2pServer.open(room.id)
        },
      })
      for (const ch of room.channels)
        if (peer.peerVisible(st, room.id, ch.id))
          nav.push({
            id: 'peer_channel_' + JSON.stringify([room.id, ch.id]),
            title: ch.name,
            subtitle: room.name,
            subtitleName: true,
            group: 'navigation',
            name: true,
            icon: Hash,
            run: () => {
              void peer.p2pServer.open(room.id, ch.id)
            },
          })
    }
  const sections: Section[] = []
  const list = rank(nav, q, ctx.usage, ctx.now).slice(0, 20)
  if (list.length) sections.push({ group: 'navigation', label: 'Places', items: list })
  const friends = rank(people, q, ctx.usage, ctx.now).slice(0, 20)
  if (friends.length) sections.push({ group: 'people', label: 'Contacts', items: friends })
  if (mode === 'all') {
    const messages = messageItems(peer.owner.store.getState(), ctx, q, 6, peer.owner)
    if (messages.length) sections.push({ group: 'messages', label: 'Messages', items: messages })
  }
  return sections
}

export function accountPaletteSections(
  actor: AccountSession,
  text: string,
  actorCtx: ResultCtx
): Section[] {
  const mode = parseQuery(text).mode
  if (mode === 'commands' || mode === 'api' || mode === 'help')
    return buildSections(actor.store.getState(), text, actorCtx, actor)
  const targets = paletteTargets(actor)
  const actorMark = actor.lifetime.sessionMark()
  const actorUser = actor.store.getState().me?.username
  return targets.flatMap(target => {
    const { account, peer, label } = target
    const origin = account.conn.origin
    const mark = account.lifetime.sessionMark()
    const username = account.store.getState().me?.username
    const token = account.store.getState().token
    const peerKey = peer?.useP2p.getState().ik
    const current = () =>
      client.live().includes(actor) &&
      actor.lifetime.sessionMark() === actorMark &&
      actor.store.getState().me?.username === actorUser &&
      account.conn.origin === origin &&
      account.lifetime.sessionMark() === mark &&
      account.store.getState().me?.username === username &&
      account.store.getState().token === token &&
      admitted(account, actor) &&
      (!peer ||
        (account.store.getState().settings.p2p &&
          account.identities.get(peer.localId) === peer &&
          peer.isCurrent() &&
          peer.useP2p.getState().enabled &&
          peer.useP2p.getState().ik === peerKey))
    const sections = () => {
      const s = account.store.getState()
      const actorState = actor.store.getState()
      const source = peer ? p2pSourceId(peer) : 'instance'
      const guestServers = s.guest ? s.guestServers : []
      const joined = new Set([...(s.me?.servers.map(x => x.name) ?? []), ...guestServers])
      const belongs = (name: string) =>
        joined.has(name) ||
        (account === actor && s.view?.kind === 'channel' && s.view.server === name)
      const pickServers = <T>(table: Record<string, T>) =>
        Object.fromEntries(Object.entries(table).filter(([server]) => belongs(server)))
      const servers = Object.fromEntries(
        Object.entries(pickServers(s.servers)).map(([name, server]) => {
          const channels = server.channels.filter(c =>
            account.viewing.canView(
              channelTarget(username ?? null, 'instance', name, c, account.conn)
            )
          )
          return [
            name,
            {
              ...server,
              channels,
              categories: server.categories?.filter(cat =>
                channels.some(c => c.category_id === cat.id)
              ),
            },
          ]
        })
      )
      const scoped = {
        ...s,
        guestServers,
        streamer: s.streamer || actorState.streamer,
        servers,
        dms: s.dms.filter(d => !Object.hasOwn(s.blocked, d.other.username)),
        members: Object.fromEntries(
          Object.entries(pickServers(s.members)).map(([server, page]) => [
            server,
            {
              ...page,
              list: page.list.filter(member => s.memberInfo[server]?.[member.username] !== null),
            },
          ])
        ),
        memberInfo: pickServers(s.memberInfo),
      }
      const ctx: ResultCtx = {
        ...actorCtx,
        index: account.indexer.paletteIndex(),
        visible: d =>
          d.source === source &&
          account.indexer.docVisible(s, d) &&
          (peer !== undefined ||
            ((d.server === null || belongs(d.server)) &&
              (d.kind !== 'member' || s.memberInfo[d.server!]?.[d.author] !== null) &&
              (d.dm === null || s.dms.some(dm => dm.id === d.dm && !dm.closed)))),
        recents: account.home.useHome
          .getState()
          .prefs.recents.filter(
            r => r.kind !== 'channel' || servers[r.server]?.channels.some(c => c.id === r.channelId)
          ),
        usage: account.palettePrefs.usePaletteUi.getState().prefs.used,
        mask: t => actorCtx.mask(maskOf(s)(t)),
      }
      return peer
        ? peerSections(peer, text, ctx)
        : buildSections(scoped, text, ctx, account, account !== actor, s)
    }
    const grouped = targets.length > 1
    const privateOwner = account.store.getState().streamer || actor.store.getState().streamer
    const heading = privateOwner
      ? peer
        ? 'P2P identity'
        : 'Account'
      : actorCtx.mask(maskOf(account.store.getState())(label))
    return sections().map(section => ({
      ...section,
      owner: grouped ? { account, local: peer?.localId ?? null, label: heading } : undefined,
      items: section.items.map(hit => {
        const item = hit.item
        // Commands, arguments and API belong to the invoking actor and already validate their action context.
        if (item.action || item.group === 'commands' || item.group === 'selection') return hit
        const latest = () =>
          current()
            ? sections()
                .flatMap(s => s.items)
                .find(h => h.item.id === item.id)?.item
            : undefined
        const mask = (text: string) =>
          account === actor && item.own
            ? text
            : actorCtx.mask(maskOf(account.store.getState(), item.own)(text))
        const title = privateOwner
          ? item.group === 'people'
            ? 'Person'
            : item.group === 'messages'
              ? 'Message'
              : 'Place'
          : mask(item.title)
        const subtitle = !privateOwner && item.subtitle ? mask(item.subtitle) : undefined
        return {
          ...hit,
          item: {
            ...item,
            title,
            subtitle,
            originalTitle:
              item.name && !privateOwner && title !== item.title ? item.title : undefined,
            originalSubtitle:
              item.subtitleName && subtitle && subtitle !== item.subtitle
                ? item.subtitle
                : undefined,
            available: () => !!latest(),
            run: () => {
              const now = latest()
              if (!now) return
              if (client.shown() !== account && !client.show(account)) return
              if (!current()) return
              if (peer) account.identities.show(peer)
              else {
                const selected = account.identities.viewed()
                if (
                  selected &&
                  (account.identities.coversView() || selected.useP2p.getState().dmList)
                )
                  selected.p2p.closeHome()
              }
              return latest()?.run()
            },
          },
        }
      }),
    }))
  })
}

// The palette observes in-memory sources only while open. Registry notifications may run while
// those registries are iterating their listeners, so rebind after the current dispatch.
export function createPaletteChanges(actor: AccountSession) {
  let revision = 0
  return {
    getSnapshot: () => revision,
    subscribe(notify: () => void) {
      let active = true,
        queued = false
      let detach: (() => void)[] = []
      const change = () => {
        revision++
        notify()
      }
      const schedule = () => {
        if (!queued) {
          queued = true
          queueMicrotask(() => {
            queued = false
            if (active) bind()
          })
        }
      }
      const bind = () => {
        for (const off of detach) off()
        detach = []
        for (const a of client.live()) {
          detach.push(
            a.store.subscribe((s, p) => {
              if (s.me !== p.me || s.token !== p.token || s.settings !== p.settings) schedule()
              else if (
                a !== actor &&
                (s.servers !== p.servers ||
                  s.dms !== p.dms ||
                  s.members !== p.members ||
                  s.memberInfo !== p.memberInfo ||
                  s.friends !== p.friends ||
                  s.onlineFriends !== p.onlineFriends ||
                  s.incomingRequests !== p.incomingRequests ||
                  s.blocked !== p.blocked ||
                  s.messages !== p.messages ||
                  s.streamer !== p.streamer ||
                  s.profanityReady !== p.profanityReady)
              )
                change()
            })
          )
          if (!admitted(a, actor)) continue
          detach.push(
            a.identities.subscribe(schedule),
            a.indexer.useIndexStatus.subscribe(change),
            a.viewing.useViewing.subscribe(change),
            a.home.useHome.subscribe(change)
          )
          for (const peer of a.identities.list())
            detach.push(
              peer.useP2p.subscribe((s, p) => {
                if (
                  s.rooms !== p.rooms ||
                  s.servers !== p.servers ||
                  s.contacts !== p.contacts ||
                  s.ik !== p.ik ||
                  s.name !== p.name ||
                  s.enabled !== p.enabled
                )
                  change()
              })
            )
        }
        change()
      }
      const offClient = client.subscribe(schedule),
        offBook = client.book.subscribe(schedule)
      bind()
      return () => {
        active = false
        offClient()
        offBook()
        for (const off of detach) off()
      }
    },
  }
}
