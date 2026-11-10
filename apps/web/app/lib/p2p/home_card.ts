import { requests, visibleContacts, type Contact } from './contacts'
import { SQUATTED, type Presence, type Status } from './node'

// What Home's Peer-to-peer card shows, from the P2P state.

export const CARD_CONTACTS = 6

export interface CardInput {
  enabled: boolean
  loading: boolean
  status: Status | 'off'
  paused: boolean
  elsewhere: boolean
  contacts: Contact[]
  presence: Record<string, Presence>
  serverInvites: number
  coOwnerAsks: number
  transferAsks: number
}

export type CardState =
  'off' | 'elsewhere' | 'starting' | 'online' | 'connecting' | 'paused' | 'blocked' | 'moved'

export interface HomeCard {
  state: CardState
  status: string
  online: number
  top: Contact[]
  requests: number
  invites: number
  asks: number
}

const nodeState = (status: Status | 'off', paused: boolean): CardState => {
  if (status === 'online') return 'online'
  if (status === 'paused' || paused) return 'paused'
  if (status === 'squatted') return 'blocked'
  return status === 'moved' ? 'moved' : 'connecting'
}

const TEXT: Record<CardState, string> = {
  off: 'Off',
  elsewhere: 'Open in another tab',
  starting: 'Starting…',
  online: 'Online',
  connecting: 'Connecting…',
  paused: 'Paused',
  blocked: SQUATTED,
  moved: 'Moved to another device',
}

// The connection in words, once P2P runs in this tab.
export const statusText = (status: Status | 'off', paused: boolean) =>
  TEXT[nodeState(status, paused)]

const stateOf = ({ enabled, elsewhere, loading, status, paused }: CardInput): CardState => {
  if (!enabled) return 'off'
  if (elsewhere) return 'elsewhere'
  return loading ? 'starting' : nodeState(status, paused)
}

export const homeCard = (s: CardInput): HomeCard => {
  const state = stateOf(s)
  if (state === 'off')
    return { state, status: TEXT.off, online: 0, top: [], requests: 0, invites: 0, asks: 0 }
  const online = visibleContacts(s.contacts).filter(
    c => c.state === 'mutual' && s.presence[c.ik] === 'online'
  )
  return {
    state,
    status: TEXT[state],
    online: online.length,
    top: online.slice(0, CARD_CONTACTS),
    requests: requests(s.contacts).length,
    invites: s.serverInvites,
    asks: s.coOwnerAsks + s.transferAsks,
  }
}

export const onlineText = (n: number) =>
  n === 0 ? 'No contacts online' : `${n} ${n === 1 ? 'contact' : 'contacts'} online`

export interface CardRow {
  id: 'requests' | 'invites' | 'asks'
  count: number
  text: string
}

const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// The things waiting for an answer, each a row that opens P2P.
export const cardRows = ({ requests, invites, asks }: HomeCard): CardRow[] =>
  (
    [
      { id: 'requests', count: requests, text: counted(requests, 'message request') },
      { id: 'invites', count: invites, text: counted(invites, 'server invite') },
      { id: 'asks', count: asks, text: counted(asks, 'co-owner or transfer request') },
    ] as const
  ).filter(row => row.count > 0)

// Where a P2P action from Home leads: turning P2P on first, the P2P page while this tab can't
// act, or its own dialog.
export const p2pEntry = (state: CardState): 'enable' | 'home' | 'dialog' =>
  state === 'off' ? 'enable' : state === 'elsewhere' || state === 'starting' ? 'home' : 'dialog'
