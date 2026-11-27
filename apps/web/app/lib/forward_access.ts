import { useEffect, useReducer } from 'react'
import { locatedQuote, quoteSource, sourceAccess, sourceTarget } from './forward_viewing'
import { locateOnce, locatedNow, membersOf, type Located } from './forward_locate'
import { useAccount, useStore } from './client/react'
import type { Message } from './types'

// Where the original of copy `id` is, asked once for every view of the copy and again once the
// answer may be stale.
export function useLocated(id: number | undefined, active: boolean): Located | undefined {
  const owner = useAccount()
  const session = owner.lifetime.sessionMark()
  const ask = active && !!id && id > 0
  const found = useStore(() => (ask && id ? locatedNow(owner, id) : undefined))
  const members = useStore(membersOf)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const missing = ask && !found
  useEffect(() => {
    if (!missing || !id) return
    let live = true
    void locateOnce(owner, id).then(() => {
      if (live) redraw()
    })
    return () => {
      live = false
    }
  }, [owner, id, missing, session, members])
  return found
}

// Whether a forwarded copy's text may show here: the local choice for its source room. A copy
// that doesn't name its source is located through the viewer's own access. `server`: the
// copy's server when this client hasn't loaded it.
export function useForwardAccess(
  m: Pick<Message, 'forward' | 'channel_id'> | null | undefined,
  { server, active = true }: { server?: string; active?: boolean } = {}
) {
  const owner = useAccount()
  const { store, viewing } = owner
  viewing.useViewing(s => s.revision)
  const servers = useStore(s => s.servers)
  const fwd = m?.forward
  const id = fwd?.source_id
  const known = m && fwd ? quoteSource(store.getState(), m, server) : undefined
  const located = useLocated(id, active && !!fwd && !known)
  const source = known ?? (located ? locatedQuote(located) : undefined)
  const label =
    known?.kind === 'channel' && known.id === fwd?.origin_channel_id
      ? fwd.origin_sensitive === true
      : undefined
  const sourceName = source?.kind === 'channel' ? source.server : undefined
  const access = useStore(s => (fwd ? sourceAccess(s, source, label, owner) : 'open'))
  useEffect(() => {
    if (active && sourceName && access === 'unknown')
      void store
        .getState()
        .discoverChannels(sourceName)
        .catch(() => {})
  }, [store, active, sourceName, access, servers])
  const target = access === 'open' ? null : sourceTarget(store.getState(), source, label, owner)
  return { access, target }
}
