'use client'

import { useStore as useBoundStore } from 'zustand'
import { client } from '../lib/client/client'
import { useAccount } from '../lib/client/react'
import { useP2p, useP2pApp } from '../lib/client/p2p_react'
import { resolveViewActor } from '../lib/client/view_actor'
import { isHosted } from '../lib/place/place'
import { usePlace } from '../lib/place/react'
import { useMask, useStore } from '../lib/store'
import { AccountTag } from './account_tag'
import { Row } from './layout'

type ViewActor = ReturnType<typeof resolveViewActor>

export function useViewActor(peer: Parameters<typeof resolveViewActor>[3] = null) {
  const account = useAccount()
  const book = useBoundStore(client.book, b => b)
  const username = useStore(s =>
    s.guest ? null : (s.me?.username ?? account.credentialTarget ?? null)
  )
  return resolveViewActor(book, account.conn.origin, username, peer)
}

export function usePeerActor() {
  const identity = useP2pApp()
  const name = useP2p(s => s.name)
  const ik = useP2p(s => s.ik)
  const actor = useViewActor(identity ? { local: identity.localId, name, ik } : null)
  return identity && actor
}

// Who writes in the place around: the identity in a P2P place, else the account.
export function usePlaceActor() {
  const place = usePlace()
  const peer = usePeerActor()
  const own = useViewActor()
  return place && !isHosted(place) ? peer : own
}

export function useActorSuffix(actor: ViewActor) {
  const mask = useMask()
  const streamer = useStore(s => s.streamer)
  return actor && !streamer ? ' as ' + mask(actor.row.display) : ''
}

export function ActorLabel({
  actor,
  header = false,
  seen = false,
}: {
  actor: ViewActor
  header?: boolean
  seen?: boolean
}) {
  if (!actor) return null
  return (
    <span
      data-view-actor
      className={
        'inline-flex min-w-0 text-xs text-on-surface-variant ' +
        (header ? 'max-md:shrink-0 md:max-w-44' : 'max-w-full')
      }
    >
      <Row as="span" gap="xs">
        {seen && <span className="shrink-0">Seen as</span>}
        <AccountTag {...actor} compactOnPhone={header} />
      </Row>
    </span>
  )
}

export function ViewActorTag({
  header,
  peer,
}: {
  header?: boolean
  peer?: Parameters<typeof useViewActor>[0]
}) {
  return <ActorLabel actor={useViewActor(peer)} header={header} />
}
export function PeerActorTag({ header, seen }: { header?: boolean; seen?: boolean }) {
  return <ActorLabel actor={usePeerActor()} header={header} seen={seen} />
}
