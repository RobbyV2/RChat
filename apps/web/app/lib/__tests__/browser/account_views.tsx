import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceGrid } from '../../../components/voice_grid'
import { profileKey, rememberProfile } from '../../profile'
import { ServerUploadExpiry } from '../../../components/upload_expiry'
import { ProfileButton } from '../../../components/profile_card'
import { AccountProvider } from '../../client/react'
import { client } from '../../client/client'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import type { ServerDetail } from '../../types'
import { Secret } from '../../secret'

const shown = client.shown()
const owner = new AccountSession(new InstanceConnection(endpointsFrom('https://owner.test', null)))
const club: ServerDetail = {
  name: 'club',
  display_name: 'Club',
  creator: null,
  has_password: false,
  banner_color: null,
  name_color: null,
  channels: [],
  roles: [],
  role_limits: { held_above: [], channel_grants: [], channel_denies: [] },
  member_count: 0,
  online_count: 0,
  categories: [],
  description: null,
  everyone_perms: 0n,
  guest_voice: false,
  hide_members: false,
  icon_image: null,
  icon_kind: 'identicon' as const,
  join_mode: 'name',
  layout_version: 0,
  listed: false,
  members_visible: false,
  my_perms: 0n,
  my_profile: null,
  profiles_mode: 'all' as const,
  public_read: null,
  read_only: [],
  roles_order_confirmed: false,
  roles_version: 0,
  separators: [],
  upload_ttl: null,
  seal: { forced: false, on: false },
  upload_expiry: { mode: 'never' as const },
}
for (const account of [shown, owner]) {
  account.api.setToken(Secret.of(account.conn.host))
  const mark = account.lifetime.sessionMark()
  rememberProfile(
    profileKey('peer', 'club'),
    {
      user: {
        username: 'peer',
        display_name: 'Peer',
        avatar_kind: 'identicon',
        avatar_color: null,
        avatar_image: null,
      },
      banner_color: account === owner ? '#0033ff' : '#ff1100',
      bio: null,
      created_at: 1,
      member: null,
      server_banner: null,
      server_bio: null,
    },
    mark,
    mark
  )
  account.store.setState({
    servers: { club },
    view: { kind: 'channel', server: 'club', channelId: 1 },
    voiceUsers: { 1: ['peer'] },
  })
  account.store.subscribe(state => {
    document.body.setAttribute(
      account === shown ? 'data-shown' : 'data-owner',
      JSON.stringify([
        state.profile?.user.username ?? null,
        state.servers.club.upload_expiry?.mode ?? null,
      ])
    )
  })
}

function ProfileOpener() {
  return (
    <ProfileButton
      user={{
        username: 'reader',
        display_name: 'Reader',
        avatar_kind: 'identicon',
        avatar_color: null,
        avatar_image: null,
      }}
      server="club"
    >
      Reader
    </ProfileButton>
  )
}
function Views() {
  const [session, setSession] = useState(owner)
  return (
    <AccountProvider session={session}>
      <button onClick={() => setSession(shown)}>Switch account</button>
      <ProfileOpener />
      <VoiceGrid channelId={1} />
      <ServerUploadExpiry key={session.renderKey} server="club" />
    </AccountProvider>
  )
}
createRoot(document.body.appendChild(document.createElement('main'))).render(<Views />)
