import { useEffect, useState } from 'react'
import type { ForwardSource } from './forward'
import { locateQuote, quoteSource, sourceAccess } from './forward_viewing'
import { useStore } from './store'
import type { Message } from './types'
import { useViewing, viewingKey } from './viewing'

// Whether a forwarded copy's text may show here: the local choice for its source room. A copy
// that doesn't name its source is located through the viewer's own access. `server`: the
// copy's server when this client hasn't loaded it.
export function useForwardAccess(
  m: Pick<Message, 'forward' | 'channel_id'> | null | undefined,
  { server, active = true }: { server?: string; active?: boolean } = {}
) {
  useViewing(s => s.revision)
  const account = useStore(s => s.me?.username ?? null)
  const servers = useStore(s => s.servers)
  const fwd = m?.forward
  const id = fwd?.source_id
  const key = viewingKey(account, ['forward', id ?? 0])
  const known = m && fwd ? quoteSource(useStore.getState(), m, server) : undefined
  const [located, setLocated] = useState<{ key: string; source: ForwardSource } | null>(null)
  const source = known ?? (located?.key === key ? located.source : undefined)
  const label =
    known?.kind === 'channel' && known.id === fwd?.origin_channel_id
      ? fwd.origin_sensitive === true
      : undefined
  const sourceName = source?.kind === 'channel' ? source.server : undefined
  const access = useStore(s => (fwd ? sourceAccess(s, source, label) : 'open'))
  const lookup = active && !!fwd && !known && !!id
  useEffect(() => {
    if (!lookup || !id) return
    let live = true
    void locateQuote(id).then(found => {
      if (live && found) setLocated({ key, source: found })
    })
    return () => {
      live = false
    }
  }, [id, key, lookup])
  useEffect(() => {
    if (active && sourceName && access === 'unknown')
      void useStore
        .getState()
        .discoverChannels(sourceName)
        .catch(() => {})
  }, [active, sourceName, access, servers])
  return { access, source, label }
}
