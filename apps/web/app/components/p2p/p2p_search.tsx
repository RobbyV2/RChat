'use client'

import { useP2p, useP2pApp, withP2pIdentity } from '../../lib/client/p2p_react'
import { P2pDm, P2pRoom } from '../../lib/place/place'
import { PlaceProvider } from '../../lib/place/react'
import SearchPanel from '../search_panel'

// Search over the P2P servers stored on this device, from the open room or conversation.
function P2pSearchPanelBody() {
  const identity = useP2pApp()!
  const room = useP2p(s => s.server?.room ?? null)
  const dm = useP2p(s => s.chat?.room ?? '')
  const place = room === null ? P2pDm.open(identity, dm) : P2pRoom.open(identity, room)
  return (
    <PlaceProvider place={place}>
      <div data-p2p-search className="contents">
        <SearchPanel />
      </div>
    </PlaceProvider>
  )
}

export const P2pSearchPanel = withP2pIdentity(P2pSearchPanelBody)
