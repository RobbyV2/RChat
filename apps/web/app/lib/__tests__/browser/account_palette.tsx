import { createRoot } from 'react-dom/client'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { SessionServices } from '../../../[[...slug]]/app_shell'
import { ContextMenu } from '../../../components/context_menu'
import { HomePage } from '../../../components/home'
import { Composer } from '../../../components/composer'
import { PaletteButton, PaletteHost } from '../../../components/palette'
import { PaletteSettingsSection } from '../../../components/palette_settings'
import { registerAppActions } from '../../actions'
import { client } from '../../client/client'
import { accountStorage } from '../../client/keys'
import { setMasking } from '../../profanity'
import { AccountProvider } from '../../client/react'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import { historyKey, historyValue, type HistoryEntry } from '../../openapi'
import { palettePrefsKey, paletteValue } from '../../palette'
import { channelTarget } from '../../viewing'
import type { Me } from '../../types'
import { Secret } from '../../secret'

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
  servers: [
    {
      name: 'garden',
      display_name: 'Garden',
      creator: null,
      is_admin: false,
      banner_color: null,
      icon_image: null,
      icon_kind: 'identicon' as const,
      name_color: null,
      profiles_mode: 'all' as const,
      timed_out_remaining: null,
      timed_out_until: null,
    },
  ],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
  avatar_image: null,
  can_create_servers: false,
  delete_at: null,
  has_password: false,
  password_temporary: null,
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
          edited_at: null,
          forward: null,
          pin_message_id: null,
          pinned_at: null,
          poll: null,
          reply_to: null,
          webhook: null,
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
  const channel = {
    id: 14,
    name: 'study',
    kind: 'text' as const,
    slowmode_seconds: 0,
    category_id: null,
    my_perms: null,
    topic: null,
  }
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
    categories: [],
    description: null,
    everyone_perms: 0n,
    guest_voice: false,
    hide_members: false,
    icon_image: null,
    icon_kind: 'identicon' as const,
    join_mode: 'name' as const,
    layout_version: 0,
    listed: false,
    members_visible: false,
    my_perms: 0n,
    my_profile: null,
    profiles_mode: 'all' as const,
    public_read: null,
    read_only: [],
    role_limits: { channel_denies: [], channel_grants: [], held_above: [] },
    roles_order_confirmed: false,
    roles_version: 0,
    seal: { forced: false, on: false },
    separators: [],
    upload_expiry: { mode: 'default' as const },
    upload_ttl: null,
  }
  owner.viewing.markPersonally(
    channelTarget(me.username, 'instance', 'garden', channel, owner.conn),
    true
  )
  for (const account of [shown, owner]) {
    const privateMessage = account.store.getState().messages.d1[0]
    const record = (action: string, id: number) => {
      document.body.dataset.foreground = client.shown() === account ? 'selected' : 'other'
      document.body.dataset.selection = [account === shown ? 'shown' : 'owner', action, id].join(
        '/'
      )
    }
    account.store.setState({ servers: { garden: server } })
    account.store.setState({
      dms: [
        {
          id: 72,
          is_self: false,
          other: { ...me, username: 'willow', display_name: 'Willow' },
          closed: false,
          friend: false,
          last_message_at: null,
          last_message_id: null,
          seal: { forced: false, on: false },
        },
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

const grouped = new URLSearchParams(location.search).has('grouped')
if (grouped) {
  const accounts = [shown, owner]
  client.book.setState({
    instances: accounts.map(account => ({
      origin: account.conn.origin,
      name: 'Garden',
      id: account.renderKey.toString(),
      accounts: [
        {
          username: me.username,
          display: me.display_name,
          avatar: null,
          connect: true,
          added: 1,
          identities: [{ local: 'field', name: 'Field', ik: null, added: 1, background: false }],
        },
      ],
      guest: false,
    })),
  })
  for (const account of accounts) {
    const token = 'fixture-' + account.conn.host
    localStorage.setItem(accountStorage(account.conn).token(me.username), token)
    account.store.setState({ token: Secret.of(token) })
  }
}
if (results) {
  // In the grouped fixture only the foreign result owner filters this word.
  await setMasking(true, async () => text => text.replaceAll('Willow', '******'))
  const filtered = grouped ? shown : owner
  filtered.store.setState({ profanityReady: true })
}
registerAppActions()
createRoot(document.body.appendChild(document.createElement('main'))).render(
  <AppRouterContext.Provider value={router}>
    {[shown, owner].map(account => (
      <AccountProvider key={account.renderKey} session={account}>
        {!grouped && <SessionServices />}
        {grouped && account === shown && (
          <button onClick={() => shown.store.setState({ blocked: { reader: true } })}>
            Block thread author
          </button>
        )}
        {results && account === owner && <PaletteHost />}
        <section aria-label={account === shown ? 'Shown' : 'Owner'}>
          {grouped ? (
            <PaletteButton />
          ) : (
            <>
              <PaletteSettingsSection />
              <HomePage onMenu={() => {}} />
              <Composer />
              <ContextMenu />
            </>
          )}
        </section>
      </AccountProvider>
    ))}
  </AppRouterContext.Provider>
)
