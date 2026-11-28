'use client'
import { useState } from 'react'
import { useP2pApp, withP2pIdentity } from '../../lib/client/p2p_react'
import type { ChannelView, ServerView } from '../../lib/p2p/server'
import { P } from '../../lib/p2p/state'
import {
  HIDE_MEMBERS_LABEL,
  P2P_MEMBERS_NOTE,
  SITE_OFF_LINE,
  hideMembersLine,
  type P2pMemberListChange,
} from '../../lib/member_list'
import { errorText, useStore } from '../../lib/store'
import { SettingSwitch } from '../settings_fields'
import { Stack } from '../layout'
import { Chips, FieldError } from '../ui'
import { notAName } from '../../lib/names'

const manages = (v: ServerView) => v.me === 'join' && (v.perms & P.ManageServer) !== 0

// Writes one change of the room's `member_list`, with its refusal shown.
function useMemberListWrite(v: ServerView) {
  const { p2pServer } = useP2pApp()!
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const write = (change: P2pMemberListChange) => {
    if (busy) return
    setBusy(true)
    void p2pServer
      .setMemberList(v.id, change)
      .then(
        () => setError(null),
        (err: unknown) => setError(errorText(err))
      )
      .finally(() => setBusy(false))
  }
  return { error, busy, write }
}

type Who = 'everyone' | 'roles'
const WHO: readonly { value: Who; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'roles', label: 'Members with these roles' },
]

// Who sees a P2P server's member list: the server-wide switch and the roles that see it, for
// members with Manage server.
function MemberListSettingsBody({ v }: { v: ServerView }) {
  const siteOn = useStore(s => s.settings.member_lists !== false)
  const { error, busy, write } = useMemberListWrite(v)
  const edit = manages(v) && siteOn
  const { hide, roles } = v.memberList
  const picked = roles ?? []
  const toggle = (id: string) =>
    write({ roles: picked.includes(id) ? picked.filter(r => r !== id) : [...picked, id] })
  return (
    <Stack gap="2xs">
      <SettingSwitch
        label={HIDE_MEMBERS_LABEL}
        hint={notAName(siteOn ? hideMembersLine(hide) : SITE_OFF_LINE)}
        value={siteOn && !hide}
        onChange={allow => write({ hide: !allow })}
        disabled={busy || !edit}
      />
      {!hide && (
        <Stack gap="xs">
          <p className="text-sm">Who can view the member list</p>
          <Chips
            label="Who can view the member list"
            value={roles === null ? 'everyone' : 'roles'}
            options={WHO}
            disabled={busy || !edit}
            onChange={who => write({ roles: who === 'everyone' ? null : picked })}
          />
          {roles !== null && (
            <Stack gap="none">
              {v.roles.map(r => (
                <SettingSwitch
                  key={r.id}
                  label={notAName(r.name)}
                  value={picked.includes(r.id)}
                  onChange={() => toggle(r.id)}
                  disabled={busy || !edit}
                />
              ))}
              {v.roles.length === 0 && (
                <p className="text-xs text-on-surface-variant">
                  No roles yet. Only moderators see the member list.
                </p>
              )}
            </Stack>
          )}
        </Stack>
      )}
      <p className="text-xs text-on-surface-variant">{P2P_MEMBERS_NOTE}</p>
      {!manages(v) && (
        <p className="text-xs text-on-surface-variant">
          Only members with Manage server can change this.
        </p>
      )}
      <FieldError message={error} />
    </Stack>
  )
}

// Whether one channel of a P2P server shows the member list, for members with Manage server.
function ChannelMemberListBody({ v, c }: { v: ServerView; c: ChannelView }) {
  const siteOn = useStore(s => s.settings.member_lists !== false)
  const { error, busy, write } = useMemberListWrite(v)
  if (!manages(v)) return null
  const hidden = v.memberList.channels.includes(c.id)
  return (
    <Stack gap="none">
      <SettingSwitch
        label="Show the member list in this channel"
        hint={
          hidden
            ? 'Only moderators see the member list here.'
            : 'Who can view the member list sees it here.'
        }
        value={!hidden}
        onChange={show => write({ channel: c.id, hide: !show })}
        disabled={busy || !siteOn}
      />
      <FieldError message={error} />
    </Stack>
  )
}

export const P2pMemberListSettings = withP2pIdentity(MemberListSettingsBody)
export const P2pChannelMemberList = withP2pIdentity(ChannelMemberListBody)
