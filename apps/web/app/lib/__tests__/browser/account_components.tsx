import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useConfigSync, useConfigStore } from '../../../components/admin/config_state'
import { ServersSection } from '../../../components/admin/servers'
import { ChannelSidebar } from '../../../components/channel_sidebar'
import { ForwardCard } from '../../../components/forwards'
import { ViewingPrompt } from '../../../components/viewing_prompt'
import type { Me, Message, ServerDetail } from '../../types'
import { MessageLink } from '../../../components/markdown_message'
import { AccountProvider } from '../../client/react'
import { AccountSession } from '../../client/session'
import { client } from '../../client/client'
import { endpointsFrom, InstanceConnection } from '../../instances'

const shown = client.shown()
const owner = new AccountSession(new InstanceConnection(endpointsFrom('https://owner.test', null)))

const reader: Me = {
  username: 'reader',
  display_name: 'Reader',
  avatar_kind: 'color',
  avatar_color: null,
  banner_color: null,
  bio: null,
  is_site_admin: true,
  appear_offline: false,
  password_kind: 'text',
  servers: [],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
}

const server: ServerDetail = {
  name: 'club',
  display_name: 'Club',
  creator: null,
  has_password: false,
  banner_color: null,
  name_color: null,
  roles: [],
  member_count: 2,
  online_count: 2,
  channels: [
    { id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 },
    { id: 2, name: 'studio', kind: 'voice', sensitive: true, slowmode_seconds: 0 },
  ],
}
const copy: Message = {
  id: 8,
  channel_id: 1,
  dm_id: null,
  thread_root_id: null,
  created_at: 1,
  content: 'Private source preview',
  author: reader,
  reply_count: 0,
  media: null,
  embeds: [],
  kind: 'user',
  call: null,
  forward: {
    author: reader,
    created_at: 1,
    source_id: 7,
    origin: '#studio - Club',
    origin_channel_id: 2,
    origin_sensitive: true,
    dropped: null,
  },
}

const saves: [string, string[] | undefined][] = []
let finishLookup: (() => void) | undefined
owner.api.getServer = async () => {
  document.body.dataset.lookup = 'pending'
  await new Promise<void>(resolve => {
    finishLookup = resolve
  })
  return server
}

for (const account of [shown, owner]) {
  account.conn.ws.resubscribe = () =>
    account.store.getState().applyWsEvent({
      type: 'voice_state',
      server: 'club',
      channel_id: 2,
      users: ['singer'],
    })
  account.store.setState({
    me: reader,
    servers: { club: server },
    view: { kind: 'channel', server: 'club', channelId: 1 },
    ensureMembers: async (_server, names) => {
      document.body.setAttribute('data-members-' + account.renderKey, names.join(','))
    },
    loadAdminOverview: async () => {},
    loadAdminServers: async () => {},
    updateSettings: async patch => {
      saves.push([account.conn.host, patch.default_servers])
      document.body.dataset.saved = JSON.stringify(saves)
    },
    openMessage: async id => {
      document.body.dataset.opened = JSON.stringify([account.conn.host, id])
    },
  })
}

function Pane({ account }: { account: AccountSession }) {
  const [adminVisible, setAdminVisible] = useState(true)
  useConfigSync(true)
  const config = useConfigStore(s => s.config)
  return (
    <section data-account={account.renderKey} aria-label={account === shown ? 'Shown' : 'Owner'}>
      <output>{config?.controls[0]?.env ?? 'Loading'}</output>
      <MessageLink href="https://owner.test/dm/1/7/">Open message</MessageLink>
      {config && (
        <>
          <ForwardCard m={copy} canDelete={false} />
          <ChannelSidebar />
        </>
      )}
      {account === owner && (
        <>
          {adminVisible && <ServersSection />}
          <button onClick={() => setAdminVisible(!adminVisible)}>Toggle admin form</button>
          <button onClick={() => account.lifetime.endSession()}>End owner lifetime</button>
          <button onClick={() => account.adminConfig.setState({ config: null })}>
            Clear config
          </button>
          <button
            onClick={() =>
              account.adminConfig.setState({
                config: {
                  controls: [
                    {
                      key: 'default_servers',
                      value: 'lobby,garden',
                      env: 'owner.test',
                      pinned: false,
                      config: null,
                    },
                  ],
                  limits: [],
                },
              })
            }
          >
            Refresh config
          </button>
          <button
            onClick={() => {
              finishLookup?.()
              delete document.body.dataset.lookup
            }}
          >
            Finish lookup
          </button>
        </>
      )}
    </section>
  )
}

function Fixture() {
  const [ownerVisible, setOwnerVisible] = useState(true)
  return (
    <>
      {[shown, ...(ownerVisible ? [owner] : [])].map(account => (
        <AccountProvider key={account.renderKey} session={account}>
          <Pane account={account} />
        </AccountProvider>
      ))}
      <ViewingPrompt />
      <button onClick={() => setOwnerVisible(false)}>Close owner</button>
    </>
  )
}
createRoot(document.body.appendChild(document.createElement('main'))).render(<Fixture />)
