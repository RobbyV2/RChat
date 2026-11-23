import { setupCallControls } from './call_controls'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { RelayPrompt } from '../../../components/relay_settings'
import { CallBanner } from '../../../components/voice_grid'
import { ConfirmDialog } from '../../../components/server_settings'
import { ContextMenu } from '../../../components/context_menu'
import { ServerRail } from '../../../components/server_rail'
import { registerAppActions } from '../../actions'
import { createRoot } from 'react-dom/client'
import { AppPreview } from '../../../components/app_preview'
import { P2pDialogs } from '../../../components/p2p/p2p_home'
import SettingsMenu from '../../../components/settings_menu'
import { ViewingPrompt } from '../../../components/viewing_prompt'
import { client } from '../../client/client'
import { AccountProvider } from '../../client/react'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import { createPeerFixture } from '../peer_fixture'
import type { Me } from '../../types'

const shown = client.shown()
const owner = new AccountSession(new InstanceConnection(endpointsFrom('https://owner.test', null)))
const me: Me = {
  username: 'reader',
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
shown.store.setState({ me, view: { kind: 'channel', server: 'garden', channelId: 1 } })
owner.store.setState({ me, view: { kind: 'channel', server: 'garden', channelId: 1 } })
shown.api.setToken('shown-token')
owner.api.setToken('owner-token')
createPeerFixture(owner, me.username).useP2p.setState({ account: me.username, enabled: false })

const events: string[] = []
function record(event: string) {
  events.push(event)
  document.body.dataset.events = JSON.stringify(events)
}
for (const account of [shown, owner]) {
  account.conn.ws.ensureConnected = () => {}
  account.conn.ws.sendVoice = message => {
    record(account.conn.host + ' ' + message.type)
    if (message.type === 'call_accept')
      queueMicrotask(() => {
        const call = account.store.getState().call
        if (call) account.store.setState({ call: { ...call, state: 'active' } })
      })
    if (message.type === 'call_accept') {
      const call = account.store.getState().call!
      account.store.setState({ call: { ...call, state: 'active' } })
    }
    return true
  }
  account.rtc.join = async () => record(account.conn.host + ' capture')
}
owner.store.setState({ openDm: async (id, nav) => record('owner DM ' + id + ' ' + nav) })

function ring() {
  if (!client.calls.current())
    void client.calls.request({ account: shown, kind: 'voice' }, () => record('left shown call'))
  owner.store.setState({
    call: {
      dmId: 3,
      dmUsers: ['reader', 'peer'],
      state: 'ringing',
      from: 'peer',
      kind: 'rtc',
      video: false,
      since: null,
    },
  })
}
function promptBoth() {
  for (const account of [shown, owner])
    void account.relays
      .prompt('relay.' + account.conn.host)
      .then(answer => record(account.conn.host + ' ' + answer))
}
const callControls = setupCallControls(owner)
registerAppActions()
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: 'test',
}
createRoot(document.body.appendChild(document.createElement('main'))).render(
  <AccountProvider session={shown}>
    <button onClick={() => shown.store.getState().openDialog({ kind: 'settings', section: 'p2p' })}>
      P2P settings
    </button>
    <button
      onClick={() => owner.store.getState().openDialog({ kind: 'settings', section: 'sync' })}
    >
      Owner settings
    </button>
    <section aria-label="Shown account overlays">
      <ContextMenu />
      <AppPreview />
    </section>
    <button onClick={ring}>Ring owner</button>
    <button onClick={promptBoth}>Prompt both relays</button>
    <CallBanner />
    <RelayPrompt />
    <ViewingPrompt />
    <P2pDialogs />
    <SettingsMenu />
    <AccountProvider session={owner}>
      {callControls}
      <RelayPrompt />
      <ConfirmDialog />
      <SettingsMenu />
      <section aria-label="Owner account rail and overlays">
        <AppRouterContext.Provider value={router}>
          <ServerRail />
        </AppRouterContext.Provider>
        <ContextMenu />
        <AppPreview />
      </section>
    </AccountProvider>
  </AccountProvider>
)
