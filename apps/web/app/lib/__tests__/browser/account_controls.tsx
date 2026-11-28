import { createRoot } from 'react-dom/client'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { HomePage } from '../../../components/home'
import { MessagePane } from '../../../components/message_pane'
import ThreadPanel from '../../../components/thread_panel'
import { ContextMenu } from '../../../components/context_menu'
import { PaletteHost } from '../../../components/palette'
import { client } from '../../client/client'
import { AccountProvider, useLiveSessions } from '../../client/react'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import { channelTarget } from '../../viewing'
import { openPollFromPalette } from '../../palette_store'
import type { BulkJob, Me, Message } from '../../types'

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
const root: Message = {
  id: 12,
  channel_id: 1,
  dm_id: null,
  thread_root_id: null,
  author: me,
  content: 'Root message',
  created_at: 1,
  reply_count: 1,
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
}
const job: BulkJob = {
  id: 6,
  scope: 'c1',
  status: 'running',
  deleted: 1,
  skipped: 0,
  estimate: 4,
  created_at: 1,
  finished_at: null,
  error: null,
}
const reply = { ...root, id: 13, thread_root_id: root.id, reply_count: 0, content: 'Thread reply' }
let finishPost = () => {}
for (const account of [shown, owner]) {
  account.store.setState({
    me,
    view: { kind: 'channel', server: 'garden', channelId: 1 },
    panel: { kind: 'thread', root },
    servers: {
      garden: {
        categories: [],
        description: null,
        everyone_perms: 0n,
        guest_voice: false,
        hide_members: false,
        join_mode: 'name' as const,
        layout_version: 0,
        listed: false,
        members_visible: false,
        my_perms: 0n,
        my_profile: null,
        public_read: null,
        role_limits: { channel_denies: [], channel_grants: [], held_above: [] },
        roles_order_confirmed: false,
        roles_version: 0,
        seal: { forced: false, on: false },
        separators: [],
        upload_expiry: { mode: 'default' as const },
        upload_ttl: null,
        ...me.servers[0],
        channels: [
          {
            id: 1,
            name: 'chat',
            kind: 'text',
            slowmode_seconds: 0,
            category_id: null,
            my_perms: null,
            topic: null,
          },
        ],
        read_only: account === shown ? [1] : [],
        roles: [],
        has_password: false,
        name_color: null,
        banner_color: null,
        member_count: 1,
        online_count: 1,
      },
    },
    messages: { c1: [root], t12: [reply] },
    bulkJobs: { c1: job },
  })
  account.api.cancelBulkJob = async id => {
    document.body.dataset.cancel = [account.conn.host, id].join('/')
    return { ...job, status: 'cancelled' }
  }
  account.api.sendThreadMessage = async id => {
    document.body.dataset.post = [account.conn.host, 'thread', id].join('/')
    return new Promise(resolve => {
      finishPost = () => resolve(reply)
    })
  }
}
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: 'test',
}
const controls = {
  finishPost: () => finishPost(),
  disposeOwner: () => owner.store.dispose(),
  replacePoll: () => openPollFromPalette({ kind: 'channel', id: 1 }, shown),
  actor: () => client.palette.store.getState().actor?.conn.host ?? null,
  selected: () =>
    [shown, owner].map(account => {
      const sel = account.store.getState().selection
      return sel
        ? { scope: sel.scope, ids: [...sel.ids], all: sel.all, ranging: sel.ranging }
        : null
    }),
  writable(ownerCanWrite: boolean) {
    for (const account of [shown, owner]) {
      const server = account.store.getState().servers.garden
      account.store.setState({
        servers: {
          garden: { ...server, read_only: (account === owner) === ownerCanWrite ? [] : [1] },
        },
      })
    }
  },
  guard(kind: 'confirm' | 'preview' | 'viewing' | null) {
    owner.store.setState({ confirm: null, activeDialog: null })
    owner.viewing.cancelViewing()
    const s = owner.store.getState()
    if (kind === 'confirm')
      s.askConfirm({ title: 'Proceed?', confirm: 'OK', body: '', action() {} })
    if (kind === 'preview') s.openDialog({ kind: 'app_preview', server: 'garden' })
    if (kind === 'viewing') {
      const target = channelTarget(
        me.username,
        'instance',
        'garden',
        { ...s.servers.garden.channels[0], id: 999 },
        owner.conn
      )
      owner.viewing.markPersonally(target, true)
      void owner.viewing.requestViewing(target)
    }
  },
}
declare global {
  interface Window {
    accountControls: typeof controls
  }
}
window.accountControls = controls

function Fixture() {
  const live = useLiveSessions()
  return (
    <AccountProvider session={shown}>
      <PaletteHost />
      {live.includes(owner) && (
        <AccountProvider session={owner}>
          <section aria-label="Home">
            <HomePage onMenu={() => {}} />
          </section>
          <section aria-label="Messages">
            <MessagePane onMenu={() => {}} onMembers={() => {}} />
          </section>
          <ThreadPanel />
          <ContextMenu />
        </AccountProvider>
      )}
    </AccountProvider>
  )
}
createRoot(document.body.appendChild(document.createElement('main'))).render(
  <AppRouterContext.Provider value={router}>
    <Fixture />
  </AppRouterContext.Provider>
)
