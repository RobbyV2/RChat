import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import SettingsMenu from '../../../components/settings_menu'
import ServerSettings from '../../../components/server_settings'
import WebhooksDialog from '../../../components/webhooks_dialog'
import AuditLogDialog from '../../../components/audit_log'
import { P2pDialogs } from '../../../components/p2p/p2p_home'
import { Dialog } from '../../../components/ui'
import { client } from '../../client/client'
import { AccountProvider } from '../../client/react'
import type { ServerView } from '../../p2p/server'
import { NO_ABOUT } from '../../server_about'
import type { RChatState } from '../../store_types'
import type { Me, Member } from '../../types'
import { Secret } from '../../secret'

// The settings dialogs of one signed-in account over a stand-in app. The hash picks what opens:
// `settings[/section]`, `focus` (a button that opens Settings at the bio), `server` (as the owner),
// `server/member` (as a member whose permissions open no section), `p2p[/tab]` or `nested`.
// `?anim` turns animations on. The app sits below a 32px band, as in the desktop app.

const shown = client.shown()
const [scene, part] = location.hash.slice(1).split('/')
// A member admin whose only permission, deleting messages, opens no section of its own.
const member: Member = {
  username: 'reader',
  display_name: 'Reader Person',
  avatar_kind: 'identicon',
  avatar_color: null,
  is_admin: true,
  is_creator: false,
  online: true,
  perms: 2,
  role_ids: [],
}
const members: RChatState['members'] =
  part === 'member' ? { garden: { list: [member], hasMore: false, loading: false, q: '' } } : {}
const me: Me = {
  username: 'reader',
  display_name: 'Reader Person',
  avatar_kind: 'identicon',
  avatar_color: null,
  banner_color: null,
  bio: null,
  is_site_admin: false,
  appear_offline: false,
  password_kind: 'text',
  servers: [{ name: 'garden', display_name: 'Garden', creator: null, is_admin: part !== 'member' }],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
}
document.documentElement.style.setProperty('--safe-top', '32px')
shown.api.setToken(Secret.of('reader-token'))
shown.store.setState(s => ({
  me,
  guest: false,
  settings: { ...s.settings, p2p: true },
  instanceHost: 'chat.a.test',
  anim: {
    on: location.search.includes('anim'),
    motion: 'always',
    style: 'subtle',
    custom: {},
  },
  servers: {
    garden: {
      name: 'garden',
      display_name: 'Garden',
      creator: 'reader',
      has_password: false,
      banner_color: null,
      name_color: null,
      channels: [{ id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }],
      roles: [],
      role_limits: { held_above: [], channel_grants: [], channel_denies: [] },
      member_count: 1,
      online_count: 1,
    },
  },
  members,
  activeDialog:
    scene === 'settings'
      ? part
        ? { kind: 'settings', section: part as never }
        : { kind: 'settings' }
      : scene === 'server'
        ? { kind: 'server_settings', server: 'garden' }
        : null,
}))
shown.identities.setAccount(me.username)
const identity = shown.identities.get()!

const room = 'book-room'
const view: ServerView = {
  id: room,
  name: 'Book club',
  color: null,
  about: NO_ABOUT,
  memberList: { hide: false, roles: null, channels: [] },
  me: 'join',
  joining: false,
  owner: 'owner-key',
  owners: ['owner-key'],
  perms: -1,
  rank: [Infinity, ''],
  roles: [],
  everyone: 0,
  history: 'shared',
  profiles: 'all',
  changeProfile: true,
  profile: {},
  profileLock: { locked: false },
  store: { on: false, earlier: false },
  system: { ch: 'general', join: true, leave: true },
  systemPick: null,
  channels: [
    {
      id: 'general',
      name: 'general',
      kind: 'text',
      pos: 0,
      send: true,
      exempt: false,
      perms: 0,
      over: {},
      everyoneSees: true,
      cat: null,
      sync: false,
    },
  ],
  categories: [],
  separators: [],
  rules: 4,
  members: [],
  online: 0,
  joined: 1,
  chans: {},
  seq: 0,
  gap: false,
  full: false,
  readOnly: null,
  voice: {},
  mods: [],
  reached: [],
  reapply: [],
  joinWait: null,
  conflict: false,
  syncing: null,
  upgraded: false,
  disputed: false,
  next: null,
  prev: null,
  carry: null,
  migrateDiff: null,
}
const openP2p = () => {
  identity.useP2p.setState(s => ({ ...s, servers: { ...s.servers, [room]: view } }))
  identity.p2p.openDialog(
    part ? { kind: 'server_settings', room, tab: part as never } : { kind: 'server_settings', room }
  )
}
if (scene === 'p2p') openP2p()
Object.assign(window, { fixture: { shown, identity, openP2p } })

function Nested() {
  const [inner, setInner] = useState(false)
  return (
    <Dialog title="Outer" size="settings" onClose={() => {}}>
      <button onClick={() => setInner(true)}>Open inner</button>
      {inner && (
        <Dialog title="Inner" compact layer="confirm" onClose={() => setInner(false)}>
          <p>Inner body</p>
        </Dialog>
      )}
    </Dialog>
  )
}

function Opener() {
  return (
    <button
      data-opener
      onClick={() => shown.store.getState().openDialog({ kind: 'settings', focus: 'bio' })}
    >
      Open settings at the bio
    </button>
  )
}

const root = createRoot(document.body.appendChild(document.createElement('main')))
root.render(
  <AccountProvider session={shown}>
    <div className="fixed inset-x-0 top-app bottom-0 overflow-hidden bg-surface text-on-surface">
      <div className="grid grid-cols-3 gap-4 p-6">
        {scene === 'focus' && <Opener />}
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} className="rounded-xl bg-primary-container p-4 text-on-primary-container">
            Channel {i}
          </div>
        ))}
      </div>
    </div>
    <SettingsMenu />
    <ServerSettings />
    <WebhooksDialog />
    <AuditLogDialog />
    <P2pDialogs />
    {scene === 'nested' && <Nested />}
  </AccountProvider>
)
