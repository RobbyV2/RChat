'use client'
import { Name, NameInput, useNameLabels } from '../name'
import { p2pName, labelWith } from '../../lib/names'
import { PeerActorTag } from '../view_actor'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Clock, Crown, Hash, Lock, Trash2, Volume2 } from 'lucide-react'
import { useMask } from '../../lib/store'
import { type ServerTab } from '../../lib/p2p/app'
import {
  EQUAL_ROLES_TEXT,
  HIGHER_ROLES_TEXT,
  OFFLINE_TEXT,
  OWNER_TEXT,
  VOUCH_INVITER_TEXT,
} from '../../lib/p2p/flows'
import { P } from '../../lib/p2p/state'
import { fieldMax } from '../../lib/p2p/event_v2'
import { voiceNotice } from '../../lib/p2p/voice'
import type { MemberView, ServerView } from '../../lib/p2p/server'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { fieldCls, Masked, Sentinel } from '../ui'
import { Row, Stack, Surface } from '../layout'
import { ServerSettingsPage } from '../server_settings_page'
import { StorageSettings } from '../storage_settings'
import { deviceKeyNote, p2pSeal, storeRegister } from '../../lib/sealing'
import { inShell } from '../../lib/platform'
import { page, PAGE } from '../../lib/paging'
import { MemberAvatar } from './p2p_badge'
import { CodeList } from './p2p_invite_dialog'
import { ServerNotices } from './p2p_server_flows'
import { SettingSwitch } from '../settings_fields'
import { SystemMessagesSection } from '../system_messages'
import { PlaceProvider, useP2pRoom } from '../../lib/place/react'
import { P2pRoom } from '../../lib/place/place'
import { ServerProfilesMode } from './p2p_server_profile'
import { ChannelAccess, MemberCard, RolesTab } from './p2p_server_roles'
import { slowTitle } from '../../lib/slowmode'
import {
  UPGRADE_CO_OWNERS,
  UPGRADE_CONFIRM,
  UPGRADE_KEEPS,
  upgradeChanges,
  upgradeOffered,
} from '../../lib/p2p_upgrade'
import { PeerTimeoutBadge } from '../timeout_dialog'
import { hex, nameColor } from '../../lib/p2p/roles'
import { openActionMenu } from '../../lib/actions/menu'
import {
  NO_FILTERS,
  allowedFilters,
  filterMembers,
  p2pMemberRow,
  type MemberFilters,
} from '../../lib/member_filters'
import { MemberFilterBar, MemberTable, MemberTableRow } from '../member_table'
import { AboutEditor, ServerIcon } from '../server_about'
import { P2pServerGlyph } from './p2p_server_glyph'
import { useP2pPictureMaker } from '../../lib/client/p2p_picture'
import { logLines } from '../../lib/audit_format'
import { permItems } from '../../lib/perm_source'
import { relativeTime } from '../../lib/timestamps'
import type { LogPage } from '../../lib/p2p/server/modlog'
import { usePermissionRules } from '../use_permission_rules'
import { time } from '../../lib/platform/time'
import { Button, IconButton } from '../controls'
import { BanList } from '../ban_list'
import { DepartureSection } from '../departure_section'
import { P2pChannelMemberList, P2pMemberListSettings } from './p2p_member_list'

// Settings of a P2P server. Every change is a signed state event that members check against
// the server's rules; what someone may not change shows read-only.

const can = (v: ServerView, bit: number) => v.me === 'join' && (v.perms & bit) !== 0

// A member's name in plain text (confirm bodies), unless streamer mode is on.

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs text-on-surface-variant">{children}</p>
)

function Overview({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer, memberName } = identity

  const me = useP2p(s => s.me)
  const [name, setName] = useState(v.name)
  const edit = can(v, P.ManageServer)
  const dirty = name.trim() !== v.name && name.trim() !== ''
  const maker = useP2pPictureMaker()
  // The text of what a signed change failed on, or null once it is written.
  const written = (change: Promise<unknown>) =>
    change.then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    )
  return (
    <Stack gap="md">
      <Stack as="label" gap="2xs">
        <span className="text-sm">Server name</span>
        <NameInput
          value={name}
          maxLength={p2p.limits().server.nameMax}
          disabled={!edit}
          onChange={e => setName(e.target.value)}
          aria-label="Server name"
        />
      </Stack>
      {edit ? (
        <Button
          variant="filled"
          size="md"
          place="self-end"
          disabled={!dirty}
          onClick={() => void p2pServer.rename(v.id, name)}
        >
          Save
        </Button>
      ) : (
        <Note>Only members with Manage server can rename the server.</Note>
      )}
      <AboutEditor
        seed={v.id}
        name={v.name}
        color={hex(v.color) ?? null}
        about={v.about}
        editable={edit}
        own={ownsP2pServer(v, me)}
        locked="Only members with Manage server can change this."
        onSave={change => p2pServer.setAbout(v.id, change)}
        picture={
          edit
            ? {
                glyph: (
                  <P2pServerGlyph pic={v.about.pic}>
                    <ServerIcon
                      seed={v.id}
                      name={v.name}
                      kind={v.about.icon}
                      color={hex(v.color) ?? null}
                    />
                  </P2pServerGlyph>
                ),
                source: {
                  off: maker.off,
                  maxBytes: maker.maxBytes,
                  has: v.about.pic !== undefined,
                  upload: async (file, crop) => {
                    const made = await maker.make(file, crop, `about:${v.id}`)
                    if (typeof made === 'string') return made
                    return written(p2pServer.setAbout(v.id, { pic: made }))
                  },
                  remove: () => written(p2pServer.setAbout(v.id, { pic: null })),
                },
              }
            : undefined
        }
      />
      <Stack gap="2xs">
        <p className="text-sm">Server profiles</p>
        <ServerProfilesMode v={v} />
        {!edit && <Note>Only members with Manage server can change this.</Note>}
      </Stack>
      <Stack gap="2xs">
        <p className="text-sm">Member list</p>
        <P2pMemberListSettings v={v} />
      </Stack>
      <Note>
        This server is stored on its members&apos; devices. {v.joined}{' '}
        {v.joined === 1 ? 'member' : 'members'}, {v.online} online now.
      </Note>
      <Stack gap="2xs">
        <p className="text-sm">{v.owners.length > 1 ? 'Owners' : 'Owner'}</p>
        <Stack as="ul" gap="sm">
          {v.owners.map(ik => (
            <Row as="li" key={ik} gap="sm">
              <MemberAvatar members={v.members} ik={ik} size={24} />
              <Name of={p2pName(memberName(v.id, ik), ik === me)} look="min-w-0 truncate text-sm" />
              <Crown size={14} className="shrink-0 text-tertiary" aria-hidden />
            </Row>
          ))}
        </Stack>
        <Note>{OWNER_TEXT}</Note>
      </Stack>
      <P2pStorage v={v} />
      <UpgradeOffer v={v} />
    </Stack>
  )
}

// The upgrade to the current rules, with what it brings: a sole owner makes the new copy from
// here.
function UpgradeOffer({ v }: { v: ServerView }) {
  const ownerAccount = useAccount()
  const { p2pServer } = useP2pApp()!
  const me = useP2p(s => s.me)
  if (!upgradeOffered(v.rules) || v.readOnly || v.upgraded || v.me !== 'join') return null
  return (
    <Stack data-p2p-upgrade gap="sm" align="start">
      <p className="text-sm">Upgrade</p>
      <Note>A newer version of P2P servers adds:</Note>
      <Stack as="ul" gap="2xs">
        {upgradeChanges(v.rules).map(line => (
          <li key={line} className="text-xs text-on-surface-variant">
            {line}
          </li>
        ))}
      </Stack>
      <Note>{UPGRADE_KEEPS}</Note>
      {me && v.owners.length === 1 && v.owner === me ? (
        <Button
          onClick={() =>
            ownerAccount.store.getState().askConfirm({
              title: 'Upgrade server?',
              body: UPGRADE_CONFIRM,
              confirm: 'Upgrade',
              action: () => void p2pServer.transfer(v.id, me),
            })
          }
        >
          Upgrade server
        </Button>
      ) : (
        <Note>{UPGRADE_CO_OWNERS}</Note>
      )}
    </Stack>
  )
}

// What this device does with encrypted storage; whether it can keep a device key is asked when
// the settings open.
export function useSealFacts() {
  const { p2pServer } = useP2pApp()!
  const facts = useP2p(s => s.seal)
  useEffect(() => {
    void p2pServer.checkSealKey().catch(() => {})
  }, [p2pServer])
  return facts
}

// "Encrypt stored messages" of a P2P server: owners and members with Manage server turn it on
// or off for every member's device. Where the site requires it and the server's own switch is
// off, "Encrypt earlier messages" is this device's alone.
function P2pStorage({ v }: { v: ServerView }) {
  const { p2pServer } = useP2pApp()!
  const facts = useSealFacts()
  const allowed = can(v, P.ManageServer)
  const state = p2pSeal({
    store: v.store,
    siteForced: facts.everything,
    deviceKey: facts.available,
    allowed,
  })
  const shared = storeRegister(v.store).on
  const earlier = (alsoOn: boolean): Promise<unknown> =>
    alsoOn || (shared && allowed)
      ? p2pServer.setStore(v.id, true, true)
      : Promise.resolve(p2pServer.sealEarlierHere(v.id))
  return (
    <StorageSettings
      state={state}
      place="p2p"
      onSwitch={on => p2pServer.setStore(v.id, on).then(() => undefined)}
      note={deviceKeyNote(facts.durable, inShell())}
      earlierStep={(close, alsoOn) => (
        <Row gap="sm" justify="end">
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="filled"
            onClick={() =>
              void earlier(alsoOn).then(done => {
                if (done !== null) close()
              })
            }
          >
            {alsoOn ? 'Turn on' : 'Encrypt'}
          </Button>
        </Row>
      )}
    />
  )
}

function Channels({ v }: { v: ServerView }) {
  const ownerAccount = useAccount()

  const identity = useP2pApp()!
  const { p2pServer, p2p } = identity

  const edit = can(v, P.ManageChannels)
  const me = useP2p(s => s.me)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const say = useNameLabels()
  const [names, setNames] = useState<Record<string, string>>({})
  const [topics, setTopics] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState('')
  const [kind, setKind] = useState<'text' | 'voice'>('text')
  const [open, setOpen] = useState<string | null>(null)
  const texts = v.channels.filter(c => c.kind === 'text')
  const shown = v.channels.filter(c => c.kind === 'text' || c.kind === 'voice')
  const [openCat, setOpenCat] = useState<string | null>(null)
  return (
    <Stack gap="md">
      {edit &&
        v.categories.map(cat => {
          const synced = v.channels.filter(c => c.cat === cat.id && c.sync).length
          return (
            <Surface
              key={cat.id}
              data-p2p-category-row={cat.name}
              pad="md"
              gap="sm"
              tone="base"
              radius="lg"
            >
              <Row gap="md" wrap lineGap="2xs">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  <Masked text={cat.name} own={ownsP2pServer(v, me)} />
                </span>
                <span className="text-xs text-on-surface-variant">
                  {synced === 1 ? '1 synced channel' : `${synced} synced channels`}
                </span>
                <Button
                  onClick={() => setOpenCat(openCat === cat.id ? null : cat.id)}
                  aria-expanded={openCat === cat.id}
                >
                  Permissions
                </Button>
              </Row>
              {openCat === cat.id && <ChannelAccess v={v} cat={cat} />}
            </Surface>
          )
        })}
      {edit && !v.textOnlyChannels && !v.readOnly && (
        <Note>Text-only channels need an upgraded server. An owner upgrades it in Overview.</Note>
      )}
      {shown.map(c => {
        const voice = c.kind === 'voice'
        const label = voice ? c.name : `#${c.name}`
        const name = names[c.id] ?? c.name
        const topic = topics[c.id] ?? c.topic ?? ''
        const dirty = (name.trim() && name.trim() !== c.name) || topic !== (c.topic ?? '')
        return (
          <Surface
            key={c.id}
            data-p2p-channel-row={c.name}
            pad="md"
            gap="sm"
            tone="base"
            radius="lg"
          >
            <Row gap="sm">
              {voice ? (
                <Volume2 size={16} className="shrink-0 text-on-surface-variant" />
              ) : (
                <Hash size={16} className="shrink-0 text-on-surface-variant" />
              )}
              {c.restrict_view && (
                <span
                  title="Private channel"
                  aria-label="Private channel"
                  role="img"
                  className="flex shrink-0 text-on-surface-variant"
                >
                  <Lock size={14} />
                </span>
              )}
              {!!c.slow && !voice && (
                <span
                  title={slowTitle(c.slow)}
                  aria-label={slowTitle(c.slow)}
                  role="img"
                  className="flex shrink-0 text-on-surface-variant"
                >
                  <Clock size={14} />
                </span>
              )}
              <input
                value={name}
                disabled={!edit}
                maxLength={p2p.limits().server.nameMax}
                onChange={e => setNames(n => ({ ...n, [c.id]: e.target.value }))}
                aria-label={`Name of ${label}`}
                className={`${fieldCls} min-w-0 flex-1`}
              />
              {edit && (voice || texts.length > 1) && (
                <IconButton
                  icon={Trash2}
                  label={labelWith`Delete ${say.covered(label, 'this channel', own)}`}
                  tone="error"
                  size="sm"
                  onClick={() =>
                    ownerAccount.store.getState().askConfirm({
                      title: 'Delete Channel',
                      body: voice
                        ? `Delete ${c.name}?`
                        : `Delete #${c.name}? Its messages stay on members' devices but can't be opened.`,
                      confirm: 'Delete',
                      action: () => void p2pServer.removeChannel(v.id, c.id),
                    })
                  }
                />
              )}
            </Row>
            <input
              value={topic}
              disabled={!edit}
              maxLength={fieldMax(p2p.limits().display.topic)}
              onChange={e => setTopics(t => ({ ...t, [c.id]: e.target.value }))}
              placeholder="Topic"
              aria-label={`Topic of ${label}`}
              className={fieldCls}
            />
            <Row gap="sm" align="stretch" justify="end" wrap>
              {edit && (
                <Button
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                  aria-expanded={open === c.id}
                >
                  Permissions
                </Button>
              )}
              {edit && dirty && (
                <Button
                  onClick={() =>
                    void p2pServer.editChannel(v.id, c.id, { name: name.trim() || c.name, topic })
                  }
                >
                  Save
                </Button>
              )}
            </Row>
            {edit && !voice && v.textOnlyChannels && (
              <SettingSwitch
                label="Text-only channel"
                hint="Allow messages and links. Block files and rich forwards."
                value={c.text_only === true}
                onChange={value => void p2pServer.editChannel(v.id, c.id, { text_only: value })}
              />
            )}
            <P2pChannelMemberList v={v} c={c} />
            {edit && open === c.id && <ChannelAccess v={v} c={c} />}
          </Surface>
        )
      })}
      {edit ? (
        <Row gap="sm" align="stretch">
          <select
            value={kind}
            onChange={e => setKind(e.target.value === 'voice' ? 'voice' : 'text')}
            aria-label="New channel type"
            className={fieldCls}
          >
            <option value="text">Text</option>
            <option value="voice">Voice</option>
          </select>
          <input
            value={fresh}
            maxLength={p2p.limits().server.nameMax}
            onChange={e => setFresh(e.target.value)}
            placeholder="new-channel"
            aria-label="New channel name"
            className={`${fieldCls} min-w-0 flex-1`}
          />
          <Button
            variant="filled"
            size="md"
            disabled={!fresh.trim()}
            onClick={() => {
              void p2pServer.addChannel(v.id, fresh, kind)
              setFresh('')
            }}
          >
            Add channel
          </Button>
        </Row>
      ) : (
        <Note>Only members with Manage channels can change channels.</Note>
      )}
      <Note>{voiceNotice(p2p.limits().voice)}</Note>
    </Stack>
  )
}

function System({ room }: { room: string }) {
  const place = useP2pRoom(room)
  return place && <SystemMessagesSection place={place} />
}

function History({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const edit = can(v, P.ManageServer)
  return (
    <Stack gap="md">
      {(
        [
          ['shared', 'Everything', 'New members get earlier messages from members who have them.'],
          [
            'joined',
            'From when they joined',
            'Members send new members only what came after their join.',
          ],
        ] as const
      ).map(([vis, label, hint]) => (
        <Surface as="label" key={vis} pad="md" tone="base" radius="lg">
          <Row as="span" gap="md" align="baseline">
            <input
              type="radio"
              name="p2p-history"
              checked={v.history === vis}
              disabled={!edit}
              onChange={() => void p2pServer.setHistory(v.id, vis)}
            />
            <Stack as="span" gap="none">
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-on-surface-variant">{hint}</span>
            </Stack>
          </Row>
        </Surface>
      ))}
      <Note>
        Members keep to this. Anyone who is in the server can still pass on what they can read.
      </Note>
    </Stack>
  )
}

const byLocale = (a: string, b: string) => a.localeCompare(b)

function PeerMemberRow({ v, m, dated }: { v: ServerView; m: MemberView; dated: boolean }) {
  const identity = useP2pApp()!
  const acct = useAccount()
  const me = useP2p(s => s.me)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  const timeout = v.timeouts === true && can(v, P.TimeoutMembers)
  const roles = m.roles
    .map(id => v.roles.find(r => r.id === id)?.name)
    .filter((n): n is string => !!n)
    .map(mask)
  const facts = [roles.join(', '), m.via ? `Joined with: ${mask(m.via.label) || 'Invite'}` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <MemberTableRow
      rowKey={m.name}
      avatar={<MemberAvatar members={v.members} ik={m.ik} size={28} />}
      name={
        <Name
          data-p2p-member-line={m.name}
          of={p2pName(m.name, m.ik === me)}
          color={nameColor(m, v.roles)}
          look="min-w-0 flex-1 truncate text-sm"
        />
      }
      badges={
        <>
          {m.owner && (
            <span title="Owner" aria-label="Owner" role="img" className="flex text-tertiary">
              <Crown size={14} />
            </span>
          )}
          {m.m === 'invite' && (
            <span className="shrink-0 text-xs text-on-surface-variant">
              {m.waits ? VOUCH_INVITER_TEXT : 'Invited'}
            </span>
          )}
          {(m.ik === me || timeout) && <PeerTimeoutBadge m={m} compact />}
        </>
      }
      facts={facts || null}
      joinedAt={m.joinedAt === undefined ? null : Math.floor(m.joinedAt / 1000)}
      created={false}
      joined={dated}
      menu={(x, y) =>
        openActionMenu(
          x,
          y,
          { kind: 'p2p_member', v, m },
          { header: <MemberCard room={v.id} ik={m.ik} /> },
          acct,
          identity
        )
      }
    />
  )
}

function Members({ v }: { v: ServerView }) {
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  const kick = can(v, P.Kick)
  const ban = can(v, P.Ban)
  const timeout = v.timeouts === true && can(v, P.TimeoutMembers)
  const search = v.memberSearch === true
  const invites = can(v, P.Invite)
  const [filters, setFilters] = useState<MemberFilters>(NO_FILTERS)
  const shown = allowedFilters(filters, { created: false, via: invites })
  const all = useMemo(() => v.members.filter(m => m.m === 'join' || m.m === 'invite'), [v.members])
  const list = filterMembers(search ? shown : NO_FILTERS, all, p2pMemberRow, byLocale)
  const [shownRows, setShownRows] = useState(PAGE)
  const more = useCallback(() => setShownRows(n => n + PAGE), [])
  const paged = page(list, shownRows)
  const choices = useMemo(() => {
    const via = new Map<string, string>()
    for (const m of all) if (m.via) via.set(m.via.id, mask(m.via.label) || 'Invite')
    return {
      roles: v.roles.map(r => ({ id: r.id, name: mask(r.name) })),
      via: invites ? [...via].map(([id, label]) => ({ id, label })) : null,
      created: false,
    }
  }, [all, v.roles, invites, mask])
  return (
    <Stack gap="md">
      {search && (
        <MemberFilterBar
          value={shown}
          onChange={f => {
            setFilters(f)
            setShownRows(PAGE)
          }}
          choices={choices}
        />
      )}
      <div data-p2p-members-tab>
        <MemberTable created={false} joined={search} label="Members">
          {paged.items.map(m => (
            <PeerMemberRow key={m.ik} v={v} m={m} dated={search} />
          ))}
        </MemberTable>
        {list.length === 0 && (
          <Surface pad="sm" inset="bar" tone="plain" radius="none">
            <p className="text-sm text-on-surface-variant">No matching members.</p>
          </Surface>
        )}
      </div>
      {paged.more && <Sentinel key={shownRows} onVisible={more} />}
      {(kick || ban || timeout) && (
        <Stack gap="2xs">
          <Note>{EQUAL_ROLES_TEXT}</Note>
          <Note>{HIGHER_ROLES_TEXT}</Note>
          <Note>{OFFLINE_TEXT}</Note>
        </Stack>
      )}
    </Stack>
  )
}

// The server's moderation log: who changed what, to whom, why, and what changed, newest first.
function ModerationLog({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer, p2p, memberName } = identity
  const me = useP2p(s => s.me)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const say = useNameLabels()
  const maskRole = useMask(own)
  const ready = usePermissionRules()
  const [pages, setPages] = useState<LogPage[]>([])
  const [loading, setLoading] = useState(false)
  // Bumped whenever the log starts over: a page asked for before that is dropped.
  const generation = useRef(0)
  const seq = v.seq
  const paged = pages.length > 1
  useEffect(() => {
    if (paged) return
    let live = true
    const mine = ++generation.current
    void p2pServer.moderationLog(v.id).then(page => {
      if (live && page && generation.current === mine) setPages([page])
    })
    return () => {
      live = false
    }
  }, [p2pServer, v.id, seq, paged])
  if (!ready) return null
  const events = pages.flatMap(p => p.events)
  const next = pages[pages.length - 1]?.next ?? null
  const roleNames = pages[pages.length - 1]?.roleNames ?? {}
  const more = () => {
    if (next === null || loading) return
    const mine = generation.current
    setLoading(true)
    void p2pServer.moderationLog(v.id, next).then(page => {
      setLoading(false)
      if (page && generation.current === mine) setPages(ps => [...ps, page])
    })
  }
  const latest = () => {
    generation.current += 1
    setPages(ps => ps.slice(0, 1))
  }
  const name = (ik: string) => say(p2pName(memberName(v.id, ik), ik === me), 'a member')
  const lines = logLines(events, {
    member: name,
    role: id => {
      const named = v.roles.find(r => r.id === id)?.name ?? roleNames[id]
      return named === undefined ? null : maskRole(named)
    },
    channel: id => {
      const c = v.channels.find(x => x.id === id)
      if (c) return c.kind === 'voice' ? maskRole(c.name) : `#${maskRole(c.name)}`
      const cat = v.categories.find(x => x.id === id)
      return cat ? maskRole(cat.name) : null
    },
    text: maskRole,
    items: permItems(v.rules),
    reasonMax: p2p.limits().display.reason,
    timed: v.timeouts === true,
  })
  const now = time().now()
  return (
    <Stack data-p2p-modlog gap="sm">
      {lines.length === 0 && pages.length > 0 && <Note>Nothing yet.</Note>}
      <Stack aria-label="Moderation log" as="ul" gap="2xs">
        {lines.map(l => (
          <Surface
            key={l.id}
            data-p2p-log={l.act}
            as="li"
            pad="md"
            inset="bar"
            gap="3xs"
            tone="base"
            radius="lg"
          >
            <Row gap="sm" align="start" place="min-w-0">
              <MemberAvatar members={v.members} ik={l.a} size={20} />
              <span className="min-w-0 flex-1 text-sm break-words">
                <Name of={p2pName(memberName(v.id, l.a), l.a === me)} look="font-medium" />{' '}
                <span className="text-on-surface-variant">{l.act}</span>
                {l.target && (
                  <> {l.targetKind === 'member' ? <Name of={p2pName(l.target)} /> : l.target}</>
                )}
              </span>
              <time
                dateTime={new Date(l.at).toISOString()}
                title={new Date(l.at).toLocaleString()}
                className="shrink-0 text-xs text-on-surface-variant"
              >
                {relativeTime(l.at, now)}
              </time>
            </Row>
            {l.undone && <p className="text-xs text-on-surface-variant">Not in force</p>}
            {l.reason && (
              <p className="text-xs text-on-surface-variant">
                Reason: <Masked text={l.reason} own={l.a === me} />
              </p>
            )}
            {l.facts.map(([k, val]) => (
              <p key={k} className="text-xs text-on-surface-variant">
                {k}: {k === 'For' ? <Name of={p2pName(val)} /> : val}
              </p>
            ))}
          </Surface>
        ))}
      </Stack>
      <Row gap="sm" align="stretch" wrap>
        {next !== null && (
          <Button onClick={more} disabled={loading}>
            Show more
          </Button>
        )}
        {paged && <Button onClick={latest}>Back to the newest</Button>}
      </Row>
    </Stack>
  )
}

function TabBody({ v, room, tab }: { v: ServerView; room: string; tab: string }) {
  const identity = useP2pApp()!
  return (
    <Surface pad="2xs" tone="plain" radius="none">
      {tab === 'overview' && <Overview key={v.name} v={v} />}
      {tab === 'roles' && <RolesTab v={v} />}
      {tab === 'channels' && <Channels v={v} />}
      {tab === 'invites' && <CodeList room={room} version={0} />}
      {tab === 'system' && <System room={room} />}
      {tab === 'history' && <History v={v} />}
      {tab === 'members' && <Members v={v} />}
      {tab === 'bans' && <BanList place={P2pRoom.open(identity, room)} />}
      {tab === 'modlog' && <ModerationLog v={v} />}
      {tab === 'leave' && <DepartureSection place={P2pRoom.open(identity, room)} />}
    </Surface>
  )
}

function ServerSettingsDialogBody({ room, tab: first }: { room: string; tab?: ServerTab }) {
  const identity = useP2pApp()!
  const v = useP2p(s => s.servers[room])
  if (!v) return null
  return (
    <PlaceProvider place={P2pRoom.open(identity, room)}>
      <ServerSettingsPage
        first={first ?? null}
        render={tab => <TabBody v={v} room={room} tab={tab} />}
        actor={<PeerActorTag header />}
        lead={
          <div className="empty:hidden">
            <ServerNotices v={v} flush />
          </div>
        }
      />
    </PlaceProvider>
  )
}

export const ServerSettingsDialog = withP2pIdentity(ServerSettingsDialogBody)
