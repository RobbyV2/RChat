'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { Clock, Crown, Hash, Lock, Trash2, Volume2 } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { banRequest, memberName, p2p, p2pServer, useP2p, type ServerTab } from '../../lib/p2p/app'
import {
  EQUAL_ROLES_TEXT,
  HIGHER_ROLES_TEXT,
  OFFLINE_TEXT,
  OWNER_TEXT,
  UNBAN_TEXT,
  VOUCH_INVITER_TEXT,
} from '../../lib/p2p/flows'
import { P } from '../../lib/p2p/state'
import { VOICE_NOTICE } from '../../lib/p2p/voice'
import type { MemberView, ServerView } from '../../lib/p2p/server'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { Dialog, fieldCls, filledBtn, Masked, sectionCls, Sentinel, textBtn } from '../ui'
import { page, PAGE } from '../../lib/paging'
import { KeyAvatar } from './p2p_badge'
import { CodeList } from './p2p_invite_dialog'
import { ServerNotices } from './p2p_server_flows'
import { withdrawRequest } from './p2p_server_view'
import { ChannelAccess, MemberCard, roleMenuItems, RolesTab } from './p2p_server_roles'
import { slowTitle } from '../../lib/slowmode'
import { hex, nameColor } from '../../lib/p2p/roles'

// Settings of a P2P server. Every change is a signed state event that members check against
// the server's rules; what someone may not change shows read-only.

const TABS: { tab: ServerTab; label: string }[] = [
  { tab: 'overview', label: 'Overview' },
  { tab: 'roles', label: 'Roles' },
  { tab: 'channels', label: 'Channels' },
  { tab: 'invites', label: 'Invites' },
  { tab: 'system', label: 'System messages' },
  { tab: 'history', label: 'History' },
  { tab: 'members', label: 'Members' },
  { tab: 'bans', label: 'Bans' },
  { tab: 'leave', label: 'Leave' },
]

const can = (v: ServerView, bit: number) => v.me === 'join' && (v.perms & bit) !== 0

// A member's name in plain text (confirm bodies), unless streamer mode is on.
const who = (name: string) => (useStore.getState().streamer ? 'this member' : name)

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs text-on-surface-variant">{children}</p>
)

function Overview({ v }: { v: ServerView }) {
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
          maxLength={100}
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
      <Note>
        This server is stored on its members&apos; devices. {v.joined}{' '}
        {v.joined === 1 ? 'member' : 'members'}, {v.online} online now.
      </Note>
      <div className="flex flex-col gap-1">
        <p className="text-sm">{v.owners.length > 1 ? 'Owners' : 'Owner'}</p>
        <ul className="flex flex-col">
          {v.owners.map(ik => (
            <li key={ik} className="flex items-center gap-2 py-1">
              <KeyAvatar ik={ik} size={24} />
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
  const edit = can(v, P.ManageChannels)
  const mask = useMask(useP2p(s => ownsP2pServer(v, s.me)))
  const [names, setNames] = useState<Record<string, string>>({})
  const [topics, setTopics] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState('')
  const [kind, setKind] = useState<'text' | 'voice'>('text')
  const [open, setOpen] = useState<string | null>(null)
  const texts = v.channels.filter(c => c.kind === 'text')
  const shown = v.channels.filter(c => c.kind === 'text' || c.kind === 'voice')
  return (
    <div className="flex flex-col gap-3">
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
                maxLength={100}
                onChange={e => setNames(n => ({ ...n, [c.id]: e.target.value }))}
                aria-label={`Name of ${label}`}
                className={`${fieldCls} min-w-0 flex-1`}
              />
              {edit && (voice || texts.length > 1) && (
                <button
                  title={`Delete ${voice ? mask(c.name) : `#${mask(c.name)}`}`}
                  aria-label={`Delete ${label}`}
                  onClick={() =>
                    useStore.getState().askConfirm({
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
              maxLength={1024}
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
            {edit && open === c.id && <ChannelAccess v={v} c={c} />}
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
            maxLength={100}
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
      <Note>{VOICE_NOTICE}</Note>
    </div>
  )
}

function System({ v }: { v: ServerView }) {
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
      <KeyAvatar ik={m.ik} size={32} />
      <span
        className="streamer min-w-0 flex-1 truncate text-sm"
        style={{ color: hex(nameColor(m, v.roles)) }}
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

function Members({ v }: { v: ServerView }) {
  const me = useP2p(s => s.me)
  const ask = useStore(s => s.askConfirm)
  const openContextMenu = useStore(s => s.openContextMenu)
  const kick = can(v, P.Kick)
  const ban = can(v, P.Ban)
  const list = v.members
    .filter(m => m.m === 'join' || m.m === 'invite')
    .sort((a, b) => a.name.localeCompare(b.name))
  const [shown, setShown] = useState(PAGE)
  const more = useCallback(() => setShown(n => n + PAGE), [])
  const paged = page(list, shown)
  return (
    <div className="flex flex-col gap-3">
      <ul data-p2p-members-tab className="flex flex-col">
        {paged.items.map(m => (
          <MemberLine key={m.ik} v={v} m={m}>
            {m.m === 'join' && roleMenuItems(v, m).length > 0 && (
              <button
                onClick={e =>
                  openContextMenu(e.clientX, e.clientY, roleMenuItems(v, m), {
                    header: <MemberCard room={v.id} ik={m.ik} />,
                  })
                }
                className={textBtn}
              >
                Roles
              </button>
            )}
            {m.m === 'invite' && (
              <span className="text-xs text-on-surface-variant">
                {m.waits ? VOUCH_INVITER_TEXT : 'Invited'}
              </span>
            )}
            {m.ik !== me && m.m === 'invite' && (kick || m.myInvite) && (
              <button onClick={() => ask(withdrawRequest(v, m))} className={textBtn}>
                Withdraw
              </button>
            )}
            {m.ik !== me && !m.owner && kick && m.m === 'join' && m.below && (
              <button
                onClick={() =>
                  ask({
                    title: 'Kick Member',
                    body: `Kick ${who(m.name)}? They can come back with a new invite.`,
                    confirm: 'Kick',
                    action: () => void p2pServer.kick(v.id, m.ik),
                  })
                }
                className={textBtn}
              >
                Kick
              </button>
            )}
            {m.ik !== me && !m.owner && ban && m.below && (
              <button
                onClick={() => ask(banRequest(v, m.ik, who(m.name)))}
                className="rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest"
              >
                Ban
              </button>
            )}
          </MemberLine>
        ))}
      </ul>
      {paged.more && <Sentinel key={shown} onVisible={more} />}
      {(kick || ban) && (
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
  const lift = can(v, P.Ban)
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
          </MemberLine>
        ))}
      </ul>
      {paged.more && <Sentinel key={shown} onVisible={more} />}
      {lift && <Note>{UNBAN_TEXT}</Note>}
    </div>
  )
}

function Leave({ v }: { v: ServerView }) {
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

export function ServerSettingsDialog({ room, tab: first }: { room: string; tab?: ServerTab }) {
  const v = useP2p(s => s.servers[room])
  const [tab, setTab] = useState<ServerTab>(first ?? 'overview')
  if (!v) return null
  return (
    <Dialog title="Server settings" onClose={p2p.closeDialog} full>
      <div
        role="tablist"
        aria-label="Server settings"
        className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {TABS.map(t => (
          <button
            key={t.tab}
            role="tab"
            aria-selected={tab === t.tab}
            onClick={() => setTab(t.tab)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${
              tab === t.tab
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container-highest'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="-mx-3 mb-3 empty:hidden">
        <ServerNotices v={v} />
      </div>
      <p className={sectionCls}>{TABS.find(t => t.tab === tab)?.label}</p>
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
    </Dialog>
  )
}
