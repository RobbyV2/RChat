import type { AccountSession } from './session'
import { dmPingCount, dmTile, dmsUnread } from '../selectors'

// Registry membership and DM totals can change without changing an account's overall ping count.
export function railActivity(accounts: AccountSession[]) {
  const read = () =>
    accounts.map(account => {
      const s = account.store.getState()
      const base = dmPingCount(s)
      let pings = base
      let unread = dmsUnread(s)
      const peers = (!s.guest && s.me && s.settings.p2p ? account.identities.list() : []).flatMap(
        app => {
          const state = app.useP2p.getState()
          if (state.account === null) return []
          const tile = dmTile(s, state)
          pings += tile.pings - base
          unread ||= tile.unread
          return [{ app, enabled: state.enabled, name: state.name, ik: state.ik }]
        }
      )
      return { account, pings, unread, peers, p2pAvailable: !s.guest && (!s.me || s.settings.p2p) }
    })
  let current = read()
  const refresh = (notify: () => void) => {
    const next = read()
    if (
      next.every((s, i) => {
        const prev = current[i]
        return (
          s.pings === prev.pings &&
          s.unread === prev.unread &&
          s.p2pAvailable === prev.p2pAvailable &&
          s.peers.length === prev.peers.length &&
          s.peers.every((p, j) => {
            const last = prev.peers[j]
            return (
              p.app === last.app &&
              p.enabled === last.enabled &&
              p.name === last.name &&
              p.ik === last.ik
            )
          })
        )
      })
    )
      return
    current = next
    notify()
  }
  return {
    snapshot: () => current,
    subscribe: (notify: () => void) => {
      const change = () => refresh(notify)
      let peerOff: (() => void)[] = []
      const bind = () => {
        for (const off of peerOff) off()
        peerOff = accounts.flatMap(a =>
          a.identities.list().map(app => app.useP2p.subscribe(change))
        )
        change()
      }
      const offs = accounts.flatMap(a => [a.store.subscribe(change), a.identities.subscribe(bind)])
      bind()
      return () => {
        for (const off of [...offs, ...peerOff]) off()
      }
    },
  }
}
