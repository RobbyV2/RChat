import type { switcherRows } from './switcher_rows'

type Groups = ReturnType<typeof switcherRows>['groups']

/** Keep book order and count each instance account once. Peer badges have their own tiles. */
export function railBlocks(groups: Groups, onlyOrigin?: string) {
  const blocks = groups
    .filter(g => !onlyOrigin || g.origin === onlyOrigin)
    .map(g => {
      const accounts = g.rows.filter(r => r.local === null && r.status !== 'Signed out')
      const peers = g.rows.filter(
        r => r.local !== null && accounts.some(a => a.username === r.username)
      )
      return { ...g, accounts, peers, pings: accounts.reduce((sum, a) => sum + a.badge, 0) }
    })
    .filter(g => g.accounts.length)
  return {
    blocks,
    instanceHeaders: blocks.length > 1,
    accountCount: blocks.reduce((n, g) => n + g.accounts.length, 0),
  }
}
