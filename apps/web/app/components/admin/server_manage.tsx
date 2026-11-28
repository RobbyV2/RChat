'use client'
import { ask, sendTo } from '../../lib/asks'
import { Name, NameInput } from '../name'
import { personCalled } from '../../lib/names'
import { asAccount } from '../../lib/people'
import { askKick } from '../../lib/place/moderation'
import { HostedServer } from '../../lib/place/place'
import { useAccount } from '../../lib/client/react'
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { ServerDetail } from '../../lib/types'
import { errorText, useStore } from '../../lib/store'
import { isBuiltin } from '../../lib/admin_servers'
import { canDeleteChannel } from '../../lib/rules'
import { UserAvatar } from '../user_avatar'
import {
  AdminPermsEditor,
  BanList,
  ChannelControls,
  RolesEditor,
  ServerAppearance,
  ServerPasswordField,
} from '../server_settings'
import { MemberSearchField, useMemberSearch } from '../member_search'
import { Button, IconButton, SectionHeading } from '../controls'
import { Inset, Row, Surface } from '../layout'
import { Sentinel } from '../ui'
import { ServerEncryption } from './encryption'
import { fieldCls } from '../ui'

function NameForm({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  streamer = false,
}: {
  initial?: string
  placeholder: string
  submitLabel: string
  onSubmit: (value: string) => void
  streamer?: boolean
}) {
  const [value, setValue] = useState(initial ?? '')
  return (
    <Row
      as="form"
      gap="sm"
      place="flex-1"
      onSubmit={e => {
        e.preventDefault()
        const trimmed = value.trim()
        if (!trimmed) return
        onSubmit(trimmed)
        if (initial === undefined) setValue('')
      }}
    >
      <NameInput
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        named={streamer}
        className={`${fieldCls} min-w-24`}
      />
      <Button type="submit" place="shrink-0">
        {submitLabel}
      </Button>
    </Row>
  )
}

// Everything a server's managers can change, for the site admin.
export function ServerManage({ name, onCollapse }: { name: string; onCollapse: () => void }) {
  const ownerSession = useAccount()
  const setError = useStore(s => s.setError)
  const renameServer = useStore(s => s.renameServer)
  const createChannel = useStore(s => s.createChannel)
  const renameChannel = useStore(s => s.renameChannel)
  const deleteChannel = useStore(s => s.deleteChannel)
  const askConfirm = useStore(s => s.askConfirm)
  const banMember = useStore(s => s.banMember)
  const grantAdmin = useStore(s => s.grantAdmin)
  const cache = useStore(s => s.members[name])
  const loadMembers = useStore(s => s.loadMembers)
  const me = useStore(s => s.me)
  const builtin = useStore(s => isBuiltin(name, s.settings))
  const [detail, setDetail] = useState<ServerDetail | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)
  const [banning, setBanning] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const found = useMemberSearch(name, q)

  const refresh = useCallback(
    () =>
      sendTo(ownerSession, ask.getServer(name))
        .then(setDetail)
        .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e)))),
    [ownerSession, name, setError]
  )
  useEffect(() => {
    void refresh()
    void loadMembers(name)
  }, [refresh, name, loadMembers])
  const moreMembers = useCallback(() => void loadMembers(name), [name, loadMembers])
  const reloadSearch = found.reload
  const reloadMembers = useCallback(() => {
    void loadMembers(name, true)
    reloadSearch()
  }, [name, loadMembers, reloadSearch])

  if (!detail) return null
  const run = (fn: () => Promise<void>) => void fn().then(ownerSession.lifetime.inSession(refresh))

  return (
    <Surface tone="plain" pad="md" gap="sm">
      <NameForm
        initial={detail.display_name}
        placeholder="Server name"
        submitLabel="Rename"
        streamer
        onSubmit={v =>
          renameServer(name, v).then(
            onCollapse,
            ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e)))
          )
        }
      />
      {builtin ? (
        <p className="text-xs text-on-surface-variant">
          The built-in server keeps its address and has no password.
        </p>
      ) : (
        <>
          <ServerPasswordField
            server={name}
            hasPassword={detail.has_password}
            canRemove
            publicRead={detail.public_read ?? null}
            refresh={() => {
              void refresh()
              reloadMembers()
            }}
          />
        </>
      )}
      <ServerAppearance server={name} detail={detail} refresh={() => void refresh()} />
      <ServerEncryption server={name} seal={detail.seal} refresh={() => void refresh()} />
      <SectionHeading as="p">Roles</SectionHeading>
      <RolesEditor
        server={name}
        roles={detail.roles}
        version={detail.roles_version}
        refresh={refresh}
      />
      <SectionHeading as="p">Channels</SectionHeading>
      {detail.channels.map(c => {
        const deletable = canDeleteChannel(detail.channels, c)
        return (
          <ChannelControls
            key={c.id}
            server={name}
            channel={c}
            refresh={refresh}
            lead={
              <Row gap="sm" place="w-full">
                <NameForm
                  initial={c.name}
                  placeholder="Channel name"
                  submitLabel="Rename"
                  onSubmit={v => run(() => renameChannel(c.id, v))}
                />
                <IconButton
                  icon={Trash2}
                  label={`Delete ${c.name}`}
                  tooltip={
                    deletable
                      ? `Delete ${c.name}`
                      : c.kind === 'text'
                        ? 'Cannot delete the only text channel'
                        : 'Cannot delete the only channel'
                  }
                  tone="danger"
                  size="sm"
                  disabled={!deletable}
                  onClick={() =>
                    askConfirm({
                      title: 'Delete Channel',
                      body:
                        c.kind === 'text'
                          ? `Delete #${c.name}? Its messages are deleted for everyone.`
                          : `Delete the voice channel ${c.name}?`,
                      confirm: 'Delete',
                      action: () => run(() => deleteChannel(c.id)),
                    })
                  }
                />
              </Row>
            }
          />
        )
      })}
      <NameForm
        placeholder="New channel"
        submitLabel="Add"
        onSubmit={v => run(() => createChannel(name, v))}
      />
      <SectionHeading as="p">Bans</SectionHeading>
      <BanList server={name} />
      <SectionHeading as="p">Members ({detail.member_count})</SectionHeading>
      <MemberSearchField value={q} onChange={setQ} />
      {found.active && !found.loading && found.list.length === 0 && (
        <p className="text-sm text-on-surface-variant">No matching members.</p>
      )}
      {(found.active ? found.list : (cache?.list ?? [])).map(m => (
        <Surface key={m.username} tone="plain" radius="lg" pad="2xs" gap="xs">
          <Row gap="sm" wrap justify="end">
            <UserAvatar person={asAccount(m, 'administration')} size={24} />
            <Name of={personCalled(m.display_name)} look="min-w-24 flex-1 truncate text-sm" />
            {m.is_admin && (
              <Button
                onClick={() => setEditingAdmin(editingAdmin === m.username ? null : m.username)}
              >
                Perms
              </Button>
            )}
            <Button
              onClick={() =>
                m.is_admin
                  ? ownerSession.store.menu.revokeAdminFor(name, m.username, reloadMembers)
                  : void grantAdmin(name, m.username).then(
                      ownerSession.lifetime.inSession(reloadMembers)
                    )
              }
            >
              {m.is_admin ? 'Revoke Admin' : 'Grant Admin'}
            </Button>
            {banning === m.username ? (
              <>
                <Button onClick={() => setBanning(null)}>Cancel</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setBanning(null)
                    run(() =>
                      banMember(name, m.username).then(
                        ownerSession.lifetime.inSession(reloadMembers)
                      )
                    )
                  }}
                >
                  Confirm ban
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="danger"
                  onClick={() =>
                    askKick(HostedServer.open(ownerSession, name), m.username, reloadMembers)
                  }
                >
                  Kick
                </Button>
                {m.username !== me?.username && (
                  <Button variant="danger" onClick={() => setBanning(m.username)}>
                    Ban from server
                  </Button>
                )}
              </>
            )}
          </Row>
          {m.is_admin && editingAdmin === m.username && (
            <Inset pad="2xl" inset="sides">
              <AdminPermsEditor
                server={name}
                username={m.username}
                perms={m.perms}
                refresh={reloadMembers}
              />
            </Inset>
          )}
        </Surface>
      ))}
      {found.active
        ? found.hasMore && <Sentinel key={`q${found.list.length}`} onVisible={found.more} />
        : (cache?.hasMore ?? false) && (
            <Sentinel key={cache?.list.length ?? 0} onVisible={moreMembers} />
          )}
    </Surface>
  )
}
