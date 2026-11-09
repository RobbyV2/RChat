import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import type { WsEvent } from '../types'
import { me, serverDetail, until } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const realFetch = globalThis.fetch
let served = serverDetail('s')

beforeEach(() => {
  served = serverDetail('s')
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(served), { status: 200 })) as unknown as typeof fetch
  useStore.setState({
    guest: false,
    view: null,
    me: me('alice', {
      servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
    }),
    servers: { s: serverDetail('s') },
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('a server expiry change', () => {
  test('loads the server again, so the composer copy follows', async () => {
    served = {
      ...serverDetail('s'),
      upload_expiry: { mode: 'never', seconds: null },
      upload_ttl: null,
    }
    st().applyWsEvent({ type: 'upload_expiry_changed', server: 's' } as WsEvent)
    await until(() => st().servers.s?.upload_expiry?.mode === 'never')
    expect(st().servers.s?.upload_ttl).toBe(null)
  })
})
