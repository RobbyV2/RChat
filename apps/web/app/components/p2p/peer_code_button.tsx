'use client'

import { useAccount } from '../../lib/client/react'
import { useP2pApp } from '../../lib/client/p2p_react'
import { openPeerLink, peerCode, type PeerLink } from '../../lib/client/peer_links'
import { textBtn } from '../ui'

export function PeerCodeButton({ text, peer = false }: { text: string; peer?: boolean }) {
  const link = peerCode(text)
  return link ? <OpenCode link={link} peer={peer} /> : null
}

function OpenCode({ link, peer }: { link: PeerLink; peer: boolean }) {
  const account = useAccount()
  const app = useP2pApp()
  if (peer && !app) return null
  return (
    <button
      type="button"
      className={textBtn}
      onClick={() => openPeerLink(account, link, peer ? app : null)}
    >
      {link.kind === 'invite' ? 'Open P2P invite' : 'Open P2P contact code'}
    </button>
  )
}
