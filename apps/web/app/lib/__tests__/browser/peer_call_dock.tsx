import { createRoot } from 'react-dom/client'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import AppShell from '../../../[[...slug]]/app_shell'
import { client } from '../../client/client'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import type { Me } from '../../types'

const me: Me = {
  username: 'sam',
  display_name: 'Reader',
  avatar_kind: 'identicon',
  avatar_color: null,
  banner_color: null,
  bio: null,
  is_site_admin: false,
  appear_offline: false,
  password_kind: 'text',
  servers: [{ name: 'garden', display_name: 'Garden', creator: null, is_admin: false }],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
}

const account = new AccountSession(
  new InstanceConnection(endpointsFrom('https://owner.test', null))
)
account.store.setState(s => ({ me, settings: { ...s.settings, p2p: true } }))
account.identities.setAccount('sam')
const sibling = account.identities.add('work')
const query = new URLSearchParams(location.search)
async function shell() {
  if (!query.has('background')) client.shown = () => account
  const voice = query.has('voice')
  sibling.callRtc.active = () => true
  sibling.useP2p.setState({
    voice: voice ? { room: 'server', ch: 'voice' } : null,
    call: voice
      ? null
      : {
          id: 'call',
          room: 'room',
          peer: 'peer',
          dir: 'out',
          state: 'active',
          video: false,
          since: 1,
          startedAt: 1,
        },
  })
  await client.calls.request(
    { account, identity: 'work', kind: voice ? 'p2p-voice' : 'p2p-call' },
    () => {}
  )
  const shown = client.shown()
  Object.assign(window, {
    confirmOverCall: () =>
      shown.store.getState().askConfirm({
        title: 'Confirm action',
        body: 'Continue?',
        confirm: 'Continue',
        action: () => {},
      }),
  })
  shown.store.setState(s => ({
    me,
    token: 'fixture',
    bootstrap: async () => {},
    home: false,
    view: { kind: 'dm', dmId: 1 },
    settings: { ...s.settings, p2p: true },
  }))
  const router = {
    back() {},
    forward() {},
    refresh() {},
    push() {},
    replace() {},
    prefetch() {},
    bfcacheId: 'fixture',
  }
  return (
    <AppRouterContext.Provider value={router}>
      <AppShell />
    </AppRouterContext.Provider>
  )
}

void shell().then(view =>
  createRoot(document.body.appendChild(document.createElement('main'))).render(view)
)
