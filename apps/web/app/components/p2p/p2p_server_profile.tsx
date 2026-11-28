'use client'

import { p2pName } from '../../lib/names'
import type { Person } from '../../lib/people'
import { useP2p, useP2pApp, withP2pIdentity } from '../../lib/client/p2p_react'
import { draftOfExtras, extrasOf } from '../../lib/server_profile_editor'
import { ProfileEditor, ProfileReset, ProfilesModeField } from '../server_profile_dialog'
import type { ServerView } from '../../lib/p2p/server'
import { P } from '../../lib/p2p/state'
import { KeyAvatar } from './p2p_badge'

// A P2P identity's picture: its key's identicon, under the avatar set for the server.
const keyAvatar = (user: Person, size: number) => <KeyAvatar person={user} size={size} />

// Your own profile in a P2P server: what this device signs into it next to your P2P name.
function ServerProfileDialogBody({ room }: { room: string }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer, p2pUser } = identity
  const v = useP2p(s => s.servers[room])
  const me = useP2p(s => s.me)
  const name = useP2p(s => s.name)
  if (!v || !me || v.me !== 'join') return null
  const names = v.profiles === 'all'
  const saved = draftOfExtras(v.profile)
  return (
    <ProfileEditor
      onClose={p2p.closeDialog}
      source={{
        account: p2pUser(me, name || 'You'),
        accountBio: null,
        accountBanner: null,
        origin: 'P2P profile',
        mode: v.profiles,
        names,
        saved,
        lock: v.profileLock,
        avatar: keyAvatar,
        handles: false,
        // A name set before the server stopped showing names stays stored for when it does.
        save: (_from, to) =>
          p2pServer.setRoomProfile(room, extrasOf(names ? to : { ...to, name: saved.name })),
        clear: () => p2pServer.setRoomProfile(room, {}),
      }}
    />
  )
}

// A moderator's reset of a member's profile in a P2P server, signed as a `profile_reset`.
function ProfileResetDialogBody({ room, ik }: { room: string; ik: string }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer, memberUser, profileName } = identity
  const v = useP2p(s => s.servers[room])
  const m = v?.members.find(x => x.ik === ik)
  if (!v || !m?.resetProfile) return null
  const user = memberUser(room, ik)
  // Under a nickname (or our name for them), the name they give themselves.
  const own = profileName(ik, room)
  return (
    <ProfileReset
      onClose={p2p.closeDialog}
      source={{
        user,
        subtitle: own !== user.display_name ? p2pName(own) : null,
        name: m.nick ?? null,
        lock: m.profileLocked ? p2pServer.profileLock(room, ik) : { locked: false },
        reasons: false,
        avatar: keyAvatar,
        submit: (fields, secs) => p2pServer.resetProfile(room, ik, fields, secs),
        unlock: () => p2pServer.unlockProfile(room, ik),
      }}
    />
  )
}

// The "Server profiles" choice of a P2P server's settings, written as a `profile_mode`.
function ServerProfilesModeBody({ v }: { v: ServerView }) {
  const { p2pServer } = useP2pApp()!
  const edit = v.me === 'join' && (v.perms & P.ManageServer) !== 0
  return (
    <ProfilesModeField
      mode={v.profiles}
      disabled={!edit}
      onChange={async mode => {
        const err = await p2pServer.setProfileMode(v.id, mode)
        if (err) throw new Error(err)
      }}
    />
  )
}

export const ServerProfileDialog = withP2pIdentity(ServerProfileDialogBody)
export const ProfileResetDialog = withP2pIdentity(ProfileResetDialogBody)
export const ServerProfilesMode = withP2pIdentity(ServerProfilesModeBody)
