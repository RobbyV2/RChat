'use client'
import { withP2pIdentity } from '../../lib/client/p2p_react'
import { useP2pApp, useP2p } from '../../lib/client/p2p_react'
import { ChannelCanContext, useChannelCan } from '../../lib/place/use_rights'
import type { P2pThread } from '../../lib/p2p/app'
import { PlaceProvider } from '../../lib/place/react'
import ThreadPanel from '../thread_panel'
import { P2pDm, P2pRoom } from '../../lib/place/place'

// The thread of a P2P server channel or conversation beside it (full screen on phones): the
// thread panel with the room's or the conversation's place around it.

function P2pThreadPanelBody() {
  const t = useP2p(s => s.thread)
  const known = useP2p(s => !s.thread?.ch || s.servers[s.thread.room] !== undefined)
  return t && known ? <ThreadOf key={`${t.room}/${t.root}`} t={t} /> : null
}

function ThreadOf({ t }: { t: P2pThread }) {
  const identity = useP2pApp()!
  const home = t.ch ? P2pRoom.open(identity, t.room) : P2pDm.open(identity, t.room)
  const held = useChannelCan(home, t.ch)
  const place = t.ch
    ? P2pRoom.open(identity, t.room, 'thread')
    : P2pDm.open(identity, t.room, 'thread')
  return (
    <ChannelCanContext.Provider value={held}>
      <PlaceProvider place={place}>
        <div data-p2p-thread className="contents">
          <ThreadPanel />
        </div>
      </PlaceProvider>
    </ChannelCanContext.Provider>
  )
}

export const P2pThreadPanel = withP2pIdentity(P2pThreadPanelBody)
