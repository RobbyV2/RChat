'use client'
import { PeerActorTag } from '../view_actor'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  Ban,
  Clock,
  Crown,
  Hash,
  History as HistoryIcon,
  LayoutDashboard,
  Lock,
  LogOut,
  MessageSquare,
  Shield,
  Ticket,
  Trash2,
  Users,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { type ServerTab } from '../../lib/p2p/app'
import {
  EQUAL_ROLES_TEXT,
  HIGHER_ROLES_TEXT,
  OFFLINE_TEXT,
  OWNER_TEXT,
  UNBAN_TEXT,
  VOUCH_INVITER_TEXT,
} from '../../lib/p2p/flows'
import { P } from '../../lib/p2p/state'
import { fieldMax } from '../../lib/p2p/event_v2'
import { voiceNotice } from '../../lib/p2p/voice'
import type { CategoryView, ChannelView, MemberView, ServerView } from '../../lib/p2p/server'
import { subjectNames, syncConfirmText } from '../../lib/categories'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { fieldCls, filledBtn, Masked, Sentinel, textBtn } from '../ui'
import { SettingsPage, type PageSection } from '../settings_page'
import { page, PAGE } from '../../lib/paging'
import { MemberAvatar } from './p2p_badge'
import { CodeList } from './p2p_invite_dialog'
import { ServerNotices } from './p2p_server_flows'
import { SettingSwitch } from '../settings_fields'
import { ServerProfilesMode } from './p2p_server_profile'
import { ChannelAccess, MemberCard, RolesTab } from './p2p_server_roles'
import { slowTitle } from '../../lib/slowmode'
import { banStateText, timedBan } from '../../lib/p2p/ban_expiry'
import { PeerTimeoutBadge, useNow } from '../timeout_dialog'
import { hex, nameColor, subjectName } from '../../lib/p2p/roles'
import { openActionMenu } from '../../lib/actions/menu'
import {
  NO_FILTERS,
  allowedFilters,
  filterMembers,
  p2pMemberRow,
  type MemberFilters,
} from '../../lib/member_filters'
import { MemberFilterBar, MemberTable, MemberTableRow } from '../member_table'
import { AboutEditor } from '../server_about'

// Settings of a P2P server. Every change is a signed state event that members check against
// the server's rules; what someone may not change shows read-only.

const TABS: { tab: ServerTab; label: string; icon: LucideIcon; keywords: string[] }[] = [
  {
    tab: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    keywords: ['rename', 'server name', 'server profiles'],
  },
  { tab: 'roles', label: 'Roles', icon: Shield, keywords: ['permissions', 'role'] },
  {
    tab: 'channels',
    label: 'Channels',
    icon: Hash,
    keywords: ['category', 'topic', 'slowmode', 'voice'],
  },
  { tab: 'invites', label: 'Invites', icon: Ticket, keywords: ['invite', 'code', 'link'] },
  {
    tab: 'system',
    label: 'System messages',
    icon: MessageSquare,
    keywords: ['welcome', 'join', 'leave'],
  },
  {
    tab: 'history',
    label: 'History',
    icon: HistoryIcon,
    keywords: ['earlier messages', 'new members'],
  },
  { tab: 'members', label: 'Members', icon: Users, keywords: ['member', 'kick', 'roles'] },
  { tab: 'bans', label: 'Bans', icon: Ban, keywords: ['banned', 'unban'] },
  {
    tab: 'leave',
    label: 'Leave',
    icon: LogOut,
    keywords: ['leave server', 'remove from this device'],
  },
]

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
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Server name
        <input
          value={name}
          maxLength={p2p.limits().server.nameMax}
          disabled={!edit}
          onChange={e => setName(e.target.value)}
          aria-label="Server name"
          className={`${fieldCls} streamer`}
        />
      </label>
      {edit ? (
        <button
          disabled={!dirty}
          onClick={() => void p2pServer.rename(v.id, name)}
          className={`${filledBtn} self-end`}
        >
          Save
        </button>
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
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm">Server profiles</p>
        <ServerProfilesMode v={v} />
        {!edit && <Note>Only members with Manage server can change this.</Note>}
      </div>
      <Note>
        This server is stored on its members&apos; devices. {v.joined}{' '}
        {v.joined === 1 ? 'member' : 'members'}, {v.online} online now.
      </Note>
      <div className="flex flex-col gap-1">
        <p className="text-sm">{v.owners.length > 1 ? 'Owners' : 'Owner'}</p>
        <ul className="flex flex-col">
          {v.owners.map(ik => (
            <li key={ik} className="flex items-center gap-2 py-1">
              <MemberAvatar members={v.members} ik={ik} size={24} />
              <span className="streamer min-w-0 truncate text-sm">
                <Masked text={memberName(v.id, ik)} own={ik === me} />
              </span>
              <Crown size={14} className="shrink-0 text-tertiary" aria-hidden />
            </li>
          ))}
        </ul>
        <Note>{OWNER_TEXT}</Note>
      </div>
    </div>
  )
}

function Channels({ v }: { v: ServerView }) {
  const ownerAccount = useAccount()

  const identity = useP2pApp()!
  const { p2pServer, p2p } = identity

  const edit = can(v, P.ManageChannels)
  const me = useP2p(s => s.me)
  const mask = useMask(useP2p(s => ownsP2pServer(v, s.me)))
  const [names, setNames] = useState<Record<string, string>>({})
  const [topics, setTopics] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState('')
  const [kind, setKind] = useState<'text' | 'voice'>('text')
  const [open, setOpen] = useState<string | null>(null)
  const texts = v.channels.filter(c => c.kind === 'text')
  const shown = v.channels.filter(c => c.kind === 'text' || c.kind === 'voice')
  const [openCat, setOpenCat] = useState<string | null>(null)
  const streamer = useStore(s => s.streamer)
  const syncNow = async (c: ChannelView, cat: CategoryView) => {
    const widens = await p2pServer.syncWidens(v.id, c.id)
    if (widens === null) return
    const go = () => void p2pServer.syncChannel(v.id, c.id)
    if (!widens.length) return go()
    ownerAccount.store.getState().askConfirm({
      title: 'Sync Permissions',
      body: syncConfirmText(
        cat.name,
        `#${c.name}`,
        subjectNames(widens, subj => subjectName(v, subj, mask, streamer))
      ),
      confirm: 'Sync',
      action: go,
    })
  }
  return (
    <div className="flex flex-col gap-3">
      {edit &&
        v.categories.map(cat => {
          const synced = v.channels.filter(c => c.cat === cat.id && c.sync).length
          return (
            <div
              key={cat.id}
              data-p2p-category-row={cat.name}
              className="flex flex-col gap-2 rounded-xl bg-surface-container px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  <Masked text={cat.name} own={ownsP2pServer(v, me)} />
                </span>
                <span className="text-xs text-on-surface-variant">
                  {synced === 1 ? '1 synced channel' : `${synced} synced channels`}
                </span>
                <button
                  onClick={() => setOpenCat(openCat === cat.id ? null : cat.id)}
                  aria-expanded={openCat === cat.id}
                  className={textBtn}
                >
                  Permissions
                </button>
              </div>
              {openCat === cat.id && <ChannelAccess v={v} cat={cat} />}
            </div>
          )
        })}
      {edit && !v.textOnlyChannels && !v.readOnly && (
        <div className="flex flex-col items-start gap-2">
          <Note>
            Text-only channels require an upgraded server. Members need an updated app to use the
            new copy.
          </Note>
          {me && v.owners.length === 1 && v.owner === me && !v.upgraded ? (
            <button
              className={textBtn}
              onClick={() =>
                ownerAccount.store.getState().askConfirm({
                  title: 'Upgrade server?',
                  body: 'This creates a new copy with the same owner. The old copy becomes read-only and keeps its message history.',
                  confirm: 'Upgrade',
                  action: () => void p2pServer.transfer(v.id, me),
                })
              }
            >
              Upgrade server
            </button>
          ) : (
            <Note>
              An owner can transfer the server to a member with an updated app. Every co-owner must
              approve.
            </Note>
          )}
        </div>
      )}
      {shown.map(c => {
        const voice = c.kind === 'voice'
        const label = voice ? c.name : `#${c.name}`
        const name = names[c.id] ?? c.name
        const topic = topics[c.id] ?? c.topic ?? ''
        const dirty = (name.trim() && name.trim() !== c.name) || topic !== (c.topic ?? '')
        return (
          <div
            key={c.id}
            data-p2p-channel-row={c.name}
            className="flex flex-col gap-2 rounded-xl bg-surface-container px-3 py-2"
          >
            <div className="flex items-center gap-2">
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
                <button
                  title={`Delete ${voice ? mask(c.name) : `#${mask(c.name)}`}`}
                  aria-label={`Delete ${label}`}
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
                  className="rounded-full p-1.5 text-error hover:bg-surface-container-highest"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <input
              value={topic}
              disabled={!edit}
              maxLength={fieldMax(p2p.limits().display.topic)}
              onChange={e => setTopics(t => ({ ...t, [c.id]: e.target.value }))}
              placeholder="Topic"
              aria-label={`Topic of ${label}`}
              className={fieldCls}
            />
            <div className="flex flex-wrap justify-end gap-2">
              {edit && (
                <button
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                  aria-expanded={open === c.id}
                  className={textBtn}
                >
                  Permissions
                </button>
              )}
              {edit && dirty && (
                <button
                  onClick={() =>
                    void p2pServer.editChannel(v.id, c.id, { name: name.trim() || c.name, topic })
                  }
                  className={textBtn}
                >
                  Save
                </button>
              )}
            </div>
            {edit && !voice && v.textOnlyChannels && (
              <SettingSwitch
                label="Text-only channel"
                hint="Allow messages and links. Block files and rich forwards."
                value={c.text_only === true}
                onChange={value => void p2pServer.editChannel(v.id, c.id, { text_only: value })}
              />
            )}
            {edit && open === c.id && (
              <>
                {(() => {
                  const cat = v.categories.find(x => x.id === c.cat)
                  if (!cat) return null
                  return (
                    <div
                      data-p2p-sync
                      className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant"
                    >
                      <span className="min-w-0 flex-1">
                        {c.sync
                          ? `Synced with ${cat.name}. Changing a rule here stops it.`
                          : `Not synced with ${cat.name}.`}
                      </span>
                      {!c.sync && (
                        <button onClick={() => void syncNow(c, cat)} className={textBtn}>
                          Sync now
                        </button>
                      )}
                    </div>
                  )
                })()}
                <ChannelAccess v={v} c={c} />
              </>
            )}
          </div>
        )
      })}
      {edit ? (
        <div className="flex gap-2">
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
          <button
            disabled={!fresh.trim()}
            onClick={() => {
              void p2pServer.addChannel(v.id, fresh, kind)
              setFresh('')
            }}
            className={filledBtn}
          >
            Add channel
          </button>
        </div>
      ) : (
        <Note>Only members with Manage channels can change channels.</Note>
      )}
      <Note>{voiceNotice(p2p.limits().voice)}</Note>
    </div>
  )
}

function System({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const edit = can(v, P.ManageServer)
  const texts = v.channels.filter(c => c.kind === 'text')
  const mask = useMask(useP2p(s => ownsP2pServer(v, s.me)))
  const set = (patch: Partial<ServerView['system']>) =>
    void p2pServer.setSystem(v.id, { ...v.system, ...patch })
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Channel for join and leave messages
        <select
          value={v.system.ch ?? ''}
          disabled={!edit}
          onChange={e => set({ ch: e.target.value || null })}
          className={fieldCls}
        >
          {texts.map(c => (
            <option key={c.id} value={c.id}>
              #{mask(c.name)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={v.system.join}
          disabled={!edit}
          onChange={e => set({ join: e.target.checked })}
        />
        Show when someone joins
      </label>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={v.system.leave}
          disabled={!edit}
          onChange={e => set({ leave: e.target.checked })}
        />
        Show when someone leaves
      </label>
      <Note>Every member&apos;s device writes these lines itself from who joins and leaves.</Note>
    </div>
  )
}

function History({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const edit = can(v, P.ManageServer)
  return (
    <div className="flex flex-col gap-3">
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
        <label
          key={vis}
          className="flex items-start gap-3 rounded-xl bg-surface-container px-3 py-2 text-sm"
        >
          <input
            type="radio"
            name="p2p-history"
            className="mt-1"
            checked={v.history === vis}
            disabled={!edit}
            onChange={() => void p2pServer.setHistory(v.id, vis)}
          />
          <span className="flex flex-col">
            <span className="font-medium">{label}</span>
            <span className="text-xs text-on-surface-variant">{hint}</span>
          </span>
        </label>
      ))}
      <Note>
        Members keep to this. Anyone who is in the server can still pass on what they can read.
      </Note>
    </div>
  )
}

function MemberLine({ v, m, children }: { v: ServerView; m: MemberView; children?: ReactNode }) {
  const me = useP2p(s => s.me)
  return (
    <li
      data-p2p-member-line={m.name}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-1.5"
    >
      <MemberAvatar members={v.members} ik={m.ik} size={32} />
      <span
        className="streamer min-w-0 flex-1 truncate text-sm"
        style={{ color: nameColor(m, v.roles) }}
      >
        <Masked text={m.name} own={m.ik === me} />
      </span>
      {m.owner && (
        <span title="Owner" aria-label="Owner" role="img" className="flex text-tertiary">
          <Crown size={14} />
        </span>
      )}
      {children}
    </li>
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
        <span
          data-p2p-member-line={m.name}
          className="streamer min-w-0 flex-1 truncate text-sm"
          style={{ color: nameColor(m, v.roles) }}
        >
          <Masked text={m.name} own={m.ik === me} />
        </span>
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
  const search = kick || can(v, P.TimeoutMembers) || can(v, P.ManageRoles)
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
    <div className="flex flex-col gap-3">
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
          <p className="px-2 text-sm text-on-surface-variant">No matching members.</p>
        )}
      </div>
      {paged.more && <Sentinel key={shownRows} onVisible={more} />}
      {(kick || ban || timeout) && (
        <div className="flex flex-col gap-1">
          <Note>{EQUAL_ROLES_TEXT}</Note>
          <Note>{HIGHER_ROLES_TEXT}</Note>
          <Note>{OFFLINE_TEXT}</Note>
        </div>
      )}
    </div>
  )
}

function Bans({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const lift = can(v, P.Ban)
  const now = useNow(v.members.some(timedBan), 30_000)
  const list = v.members.filter(m => m.m === 'ban').sort((a, b) => a.name.localeCompare(b.name))
  const [shown, setShown] = useState(PAGE)
  const more = useCallback(() => setShown(n => n + PAGE), [])
  if (!list.length) return <Note>Nobody is banned.</Note>
  const paged = page(list, shown)
  return (
    <div className="flex flex-col gap-3">
      <ul data-p2p-bans-tab className="flex flex-col">
        {paged.items.map(m => (
          <MemberLine key={m.ik} v={v} m={m}>
            {m.unban && (
              <button onClick={() => void p2pServer.unban(v.id, m.ik)} className={textBtn}>
                Lift ban
              </button>
            )}
            {(timedBan(m) || (lift && m.banReason)) && (
              <span className="basis-full pl-11 text-xs break-words text-on-surface-variant">
                {[banStateText(m, now), lift ? m.banReason : null].filter(Boolean).join(' · ')}
              </span>
            )}
          </MemberLine>
        ))}
      </ul>
      {paged.more && <Sentinel key={shown} onVisible={more} />}
      {lift && <Note>{UNBAN_TEXT}</Note>}
    </div>
  )
}

function Leave({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2pServer, p2p } = identity

  const ask = useStore(s => s.askConfirm)
  const me = useP2p(s => s.me)
  const owner = v.owner === me
  const inside = v.me === 'join' || v.me === 'invite'
  return (
    <div className="flex flex-col items-start gap-3">
      {inside ? (
        <>
          <Note>
            {owner
              ? 'You own this server. If you leave, nobody can rename it, change channels or ban people any more.'
              : 'Someone who can invite has to let you in again.'}
          </Note>
          <button
            onClick={() =>
              ask({
                title: 'Leave Server',
                body: `Leave ${v.name}?`,
                confirm: 'Leave',
                action: () => void p2pServer.leave(v.id),
              })
            }
            className="rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error"
          >
            Leave server
          </button>
        </>
      ) : (
        <>
          <Note>
            You aren&apos;t a member any more. What you have of it stays on this device until you
            remove it.
          </Note>
          <button
            onClick={() =>
              ask({
                title: 'Remove Server',
                body: `Remove ${v.name} and everything of it from this device?`,
                confirm: 'Remove',
                action: () => {
                  p2p.closeDialog()
                  void p2pServer.forget(v.id)
                },
              })
            }
            className="rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error"
          >
            Remove from this device
          </button>
        </>
      )}
    </div>
  )
}

function TabBody({ v, room, tab }: { v: ServerView; room: string; tab: ServerTab }) {
  return (
    <div className="px-1">
      {tab === 'overview' && <Overview key={v.name} v={v} />}
      {tab === 'roles' && <RolesTab v={v} />}
      {tab === 'channels' && <Channels v={v} />}
      {tab === 'invites' && <CodeList room={room} version={0} />}
      {tab === 'system' && <System v={v} />}
      {tab === 'history' && <History v={v} />}
      {tab === 'members' && <Members v={v} />}
      {tab === 'bans' && <Bans v={v} />}
      {tab === 'leave' && <Leave v={v} />}
    </div>
  )
}

const isTab = (id: string | null): id is ServerTab => TABS.some(t => t.tab === id)

function ServerSettingsDialogBody({ room, tab: first }: { room: string; tab?: ServerTab }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const v = useP2p(s => s.servers[room])
  const [tab, setTab] = useState<ServerTab | null>(first ?? null)
  if (!v) return null
  const sections: PageSection[] = TABS.map(t => ({
    id: t.tab,
    label: t.label,
    icon: t.icon,
    rows: [{ section: t.tab, id: `p2p_${t.tab}`, label: t.label, keywords: t.keywords }],
    render: () => <TabBody v={v} room={room} tab={t.tab} />,
  }))
  return (
    <SettingsPage
      title="Server settings"
      sections={sections}
      active={tab}
      onSection={id => setTab(isTab(id) ? id : null)}
      onClose={p2p.closeDialog}
      actor={<PeerActorTag header />}
      lead={
        <div className="-mx-3 mb-3 empty:hidden">
          <ServerNotices v={v} />
        </div>
      }
      layer="dialog"
    />
  )
}

export const ServerSettingsDialog = withP2pIdentity(ServerSettingsDialogBody)
