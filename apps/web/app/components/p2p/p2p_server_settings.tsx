'use client'

import { useState, type ReactNode } from 'react'
import { Crown, Hash, Trash2 } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { p2p, p2pServer, useP2p, type ServerTab } from '../../lib/p2p/app'
import { P } from '../../lib/p2p/state'
import type { MemberView, ServerView } from '../../lib/p2p/server'
import { Dialog, fieldCls, filledBtn, Masked, sectionCls, textBtn } from '../ui'
import { KeyAvatar } from './p2p_badge'
import { CodeList } from './p2p_invite_dialog'

// Settings of a P2P server. Every change is a signed state event that members check against
// the server's rules; what someone may not change shows read-only.

const TABS: { tab: ServerTab; label: string }[] = [
  { tab: 'overview', label: 'Overview' },
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
        <Note>Only the owner can rename the server.</Note>
      )}
      <Note>
        This server is stored on its members&apos; devices. {v.joined}{' '}
        {v.joined === 1 ? 'member' : 'members'}, {v.online} online now.
      </Note>
    </div>
  )
}

function Channels({ v }: { v: ServerView }) {
  const edit = can(v, P.ManageChannels)
  const mask = useMask()
  const [names, setNames] = useState<Record<string, string>>({})
  const [topics, setTopics] = useState<Record<string, string>>({})
  const [fresh, setFresh] = useState('')
  const texts = v.channels.filter(c => c.kind === 'text')
  return (
    <div className="flex flex-col gap-3">
      {texts.map(c => {
        const name = names[c.id] ?? c.name
        const topic = topics[c.id] ?? c.topic ?? ''
        const dirty = (name.trim() && name.trim() !== c.name) || topic !== (c.topic ?? '')
        return (
          <div key={c.id} className="flex flex-col gap-2 rounded-xl bg-surface-container px-3 py-2">
            <div className="flex items-center gap-2">
              <Hash size={16} className="shrink-0 text-on-surface-variant" />
              <input
                value={name}
                disabled={!edit}
                maxLength={100}
                onChange={e => setNames(n => ({ ...n, [c.id]: e.target.value }))}
                aria-label={`Name of #${c.name}`}
                className={`${fieldCls} min-w-0 flex-1`}
              />
              {edit && texts.length > 1 && (
                <button
                  title={`Delete #${mask(c.name)}`}
                  aria-label={`Delete #${c.name}`}
                  onClick={() =>
                    useStore.getState().askConfirm({
                      title: 'Delete Channel',
                      body: `Delete #${c.name}? Its messages stay on members' devices but can't be opened.`,
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
              aria-label={`Topic of #${c.name}`}
              className={fieldCls}
            />
            {edit && dirty && (
              <button
                onClick={() =>
                  void p2pServer.editChannel(v.id, c.id, { name: name.trim() || c.name, topic })
                }
                className={`${textBtn} self-end`}
              >
                Save
              </button>
            )}
          </div>
        )
      })}
      {edit ? (
        <div className="flex gap-2">
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
              void p2pServer.addChannel(v.id, fresh)
              setFresh('')
            }}
            className={filledBtn}
          >
            Add channel
          </button>
        </div>
      ) : (
        <Note>Only the owner can change channels.</Note>
      )}
      <Note>Voice channels in P2P servers come later.</Note>
    </div>
  )
}

function System({ v }: { v: ServerView }) {
  const edit = can(v, P.ManageServer)
  const texts = v.channels.filter(c => c.kind === 'text')
  const mask = useMask()
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

function MemberLine({ m, children }: { m: MemberView; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5">
      <KeyAvatar ik={m.ik} size={32} />
      <span className="streamer min-w-0 flex-1 truncate text-sm">
        <Masked text={m.name} />
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
  const kick = can(v, P.Kick)
  const ban = can(v, P.Ban)
  const list = v.members
    .filter(m => m.m === 'join' || m.m === 'invite')
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <ul className="flex flex-col">
      {list.map(m => (
        <MemberLine key={m.ik} m={m}>
          {m.m === 'invite' && <span className="text-xs text-on-surface-variant">Invited</span>}
          {m.ik !== me && !m.owner && kick && (
            <button
              onClick={() =>
                ask({
                  title: m.m === 'invite' ? 'Take Back Invite' : 'Kick Member',
                  body:
                    m.m === 'invite'
                      ? `Take back the invite of ${who(m.name)}?`
                      : `Kick ${who(m.name)}? They can come back with a new invite.`,
                  confirm: m.m === 'invite' ? 'Take back' : 'Kick',
                  action: () => void p2pServer.kick(v.id, m.ik),
                })
              }
              className={textBtn}
            >
              {m.m === 'invite' ? 'Take back' : 'Kick'}
            </button>
          )}
          {m.ik !== me && !m.owner && ban && (
            <button
              onClick={() =>
                ask({
                  title: 'Ban Member',
                  body: `Ban ${who(m.name)}? Nothing they post from now on is shown, and they can't come back.`,
                  confirm: 'Ban',
                  action: () => void p2pServer.ban(v.id, m.ik),
                })
              }
              className="rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest"
            >
              Ban
            </button>
          )}
        </MemberLine>
      ))}
    </ul>
  )
}

function Bans({ v }: { v: ServerView }) {
  const lift = can(v, P.Ban)
  const list = v.members.filter(m => m.m === 'ban')
  if (!list.length) return <Note>Nobody is banned.</Note>
  return (
    <ul className="flex flex-col">
      {list.map(m => (
        <MemberLine key={m.ik} m={m}>
          {lift && (
            <button onClick={() => void p2pServer.unban(v.id, m.ik)} className={textBtn}>
              Lift ban
            </button>
          )}
        </MemberLine>
      ))}
    </ul>
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
      <p className={sectionCls}>{TABS.find(t => t.tab === tab)?.label}</p>
      <div className="px-1">
        {tab === 'overview' && <Overview key={v.name} v={v} />}
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
