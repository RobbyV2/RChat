import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
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
import { useP2p } from '../../p2p/app'
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
useP2p.setState({ account: 'reader', enabled: false })

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
    <ViewingPrompt />
    <P2pDialogs />
    <SettingsMenu />
    <AccountProvider session={owner}>
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
