import { personCalled, personName, type PersonName } from '../names'
import { asAccount } from '../people'
import { userRefFor } from '../selectors'
import type { CallLog, Message } from '../types'
import { defineFeature, unsupported } from './feature'
import { fromStore, type Live } from './live'
import type { HostedDm, P2pDm } from './place'
import { shownOf } from './shown'

// The calls among a conversation's messages: who they are between, how they were connected, and
// the answer to one that rings.
export interface CallLogs {
  // The name the reader's own calls carry in `CallLog.from`; null while unknown.
  self: Live<string | null>
  // What a call's badge says of its connection: `direct` for a call of the instance that ran
  // between the two clients, `peer` for one between identities.
  mark: (call: CallLog) => 'direct' | 'peer' | null
  caller: (call: CallLog) => PersonName | null
  // The other person of the conversation `m` is in.
  other: (m: Message) => PersonName | null
  accept: (m: Message) => void
  decline: () => void
}

const hosted = ({ account }: HostedDm): CallLogs => {
  const { store } = account
  return {
    self: fromStore(store, s => s.me?.username ?? null),
    mark: call => (call.p2p === true ? 'direct' : null),
    caller: call => personName(asAccount(userRefFor(store.getState(), call.from), 'call')),
    other: m => {
      const other = store.getState().dms.find(d => d.id === m.dm_id)?.other
      return other ? personName(asAccount(other, 'call')) : null
    },
    accept: m => {
      if (m.dm_id !== null) void store.getState().openDm(m.dm_id)
      void store.getState().acceptCall()
    },
    decline: () => store.getState().declineCall(),
  }
}

const peer = (place: P2pDm): CallLogs => {
  const { useP2p, p2pCall } = place.app
  const called = (ik: string) => {
    const user = shownOf(place).get().user(ik)
    return personCalled(user.display_name, user.username)
  }
  return {
    self: fromStore(useP2p, s => s.me),
    mark: () => 'peer',
    caller: call => called(call.from),
    other: () => {
      const s = useP2p.getState()
      const ik = (s.chat?.room === place.room ? s.chat.peer : s.rooms[place.room]?.peer) ?? ''
      return ik === '' ? null : called(ik)
    },
    accept: () => void p2pCall.accept(),
    decline: () => p2pCall.decline(),
  }
}

const NOT_HERE = unsupported('Calls are in direct messages')

// The calls among the messages of a conversation.
export const callLog = defineFeature<CallLogs>('callLog', {
  hostedServer: () => NOT_HERE,
  p2pRoom: () => NOT_HERE,
  hostedDm: hosted,
  p2pDm: peer,
})
