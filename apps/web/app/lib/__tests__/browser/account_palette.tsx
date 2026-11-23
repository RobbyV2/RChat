import { createRoot } from 'react-dom/client'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { SessionServices } from '../../../[[...slug]]/app_shell'
import { ContextMenu } from '../../../components/context_menu'
import { HomePage } from '../../../components/home'
import { MessageComposer } from '../../../components/message_composer'
import { PaletteHost } from '../../../components/palette'
import { PaletteSettingsSection } from '../../../components/palette_settings'
import { registerAppActions } from '../../actions'
import { client } from '../../client/client'
import { AccountProvider } from '../../client/react'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import { historyKey, historyValue, type HistoryEntry } from '../../openapi'
import { palettePrefsKey, paletteValue } from '../../palette'
import { channelTarget } from '../../viewing'
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

const entry: HistoryEntry = {
  method: 'GET',
  path: '/api/me',
  op: 'get_me',
  status: 200,
  at: 1,
  values: { params: {}, body: '' },
}
const history = historyValue({ v: 2, items: [entry] })
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: 'test',
}

for (const account of [shown, owner]) {
  localStorage.setItem(account.conn.scoped(historyKey(me.username)), history)
  localStorage.setItem(
    account.conn.scoped(palettePrefsKey(me.username)),
    paletteValue({ v: 1, index: 'loaded', used: { welcome: { n: 1, at: 1 } } })
  )
  account.store.setState(s => ({
    messages: {
      d1: [
        {
          id: 1,
          channel_id: null,
          dm_id: 1,
          thread_root_id: null,
          author: me,
          content: 'private',
          created_at: 1,
          reply_count: 0,
          media: null,
          embeds: [],
          kind: 'user',
          call: null,
        },
      ],
    },
    me,
    view: { kind: 'channel', server: 'garden', channelId: 1 },
    settings: { ...s.settings, profanity_filter: true },
  }))
}

const results = new URLSearchParams(location.search).has('results')
if (results) {
  const channel = { id: 14, name: 'study', kind: 'text' as const, slowmode_seconds: 0 }
  const server = {
    name: 'garden',
    display_name: 'Garden',
    creator: null,
    has_password: false,
    banner_color: null,
    name_color: null,
    channels: [channel],
    roles: [],
    member_count: 2,
    online_count: 1,
  }
  owner.viewing.markPersonally(
    channelTarget(me.username, 'instance', 'garden', channel, owner.conn),
    true
  )
  for (const account of [shown, owner]) {
    const privateMessage = account.store.getState().messages.d1[0]
    const record = (action: string, id: number) => {
      document.body.dataset.selection = [account === shown ? 'shown' : 'owner', action, id].join(
        '/'
      )
    }
    account.store.setState({ servers: { garden: server } })
    account.store.setState({
      dms: [
        { id: 72, is_self: false, other: { ...me, username: 'willow', display_name: 'Willow' } },
      ],
      messages: {
        c14: [
          {
            ...privateMessage,
            id: 14,
            channel_id: 14,
            dm_id: null,
            content: 'Hidden notebook',
            reply_count: 1,
          },
        ],
        d72: [{ ...privateMessage, id: 37, dm_id: 72, content: 'Rocket notebook' }],
      },
      openDm: async id => record('dm', id),
      openMessage: async id => record('message', id),
    })
  }
}

registerAppActions()
createRoot(document.body.appendChild(document.createElement('main'))).render(
  <AppRouterContext.Provider value={router}>
    {[shown, owner].map(account => (
      <AccountProvider key={account.renderKey} session={account}>
        <SessionServices />
        {results && account === owner && <PaletteHost />}
        <section aria-label={account === shown ? 'Shown' : 'Owner'}>
          <PaletteSettingsSection />
          <HomePage onMenu={() => {}} />
          <MessageComposer />
          <ContextMenu />
        </section>
      </AccountProvider>
    ))}
  </AppRouterContext.Provider>
)
