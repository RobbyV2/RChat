import { createStore } from 'zustand/vanilla'
import { AccountSession } from '../client/session'
import { endpointsFrom, InstanceConnection } from '../instances'
import { useStore } from '../store'
import type { RChatState } from '../store_types'
import { me } from './fixtures'

export function testAccount(username: string, origin = 'https://instance.test') {
  const conn = new InstanceConnection(endpointsFrom(origin, null))
  const initial = useStore.getInitialState()
  const data = structuredClone(
    Object.fromEntries(Object.entries(initial).filter(([, value]) => typeof value !== 'function'))
  )
  const actions = Object.fromEntries(
    Object.entries(initial)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => [
        key,
        () => {
          throw new Error(`Unsupported fixture action: ${key}`)
        },
      ])
  )
  const store = createStore<RChatState>(() =>
    Object.assign({}, initial, data, actions, { me: me(username) })
  )
  return new AccountSession(conn, store)
}
