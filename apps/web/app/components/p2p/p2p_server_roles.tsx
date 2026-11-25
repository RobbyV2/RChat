'use client'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'
import type { P2pApp } from '../../lib/p2p/app/runtime'

import { useAccount } from '../../lib/client/react'
import { client } from '../../lib/client/client'

import { useState, type ReactNode, type SyntheticEvent } from 'react'
import { Crown, GripVertical, Trash2, X } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'

import { ownsP2pServer } from '../../lib/p2p/server/types'
import { registerAppActions } from '../../lib/actions'
import { ctxFor } from '../../lib/actions/ctx'
import { itemFor, menuItems, openActionMenu } from '../../lib/actions/menu'
import { peerServer } from '../../lib/actions/p2p_server'
import type { Target } from '../../lib/actions/types'
import {
  ALLOW_BOTH,
  EVERYONE_ITEMS,
  PERM_ITEMS,
  ROLE_LOCKED,
  fromHex,
  hex,
  mayTakeRole,
  mayWriteRow,
  nameColor,
  overBits,
  overFlags,
  placeRole,
} from '../../lib/p2p/roles'
import { EVERYONE, P } from '../../lib/p2p/state'
import { shownBanner, shownBio } from '../../lib/server_profile'
import type { ChannelView, MemberView, RoleView, ServerView } from '../../lib/p2p/server'
import { allowListTitle, emptyAllowText, type RestrictKey } from '../../lib/channel_access'
import { matching, nextPage, page, PAGE } from '../../lib/paging'
import { longPress } from '../context_menu'
import { dragScope } from '../drag'
import {
  ColorSwatch,
  PermChecks,
  RestrictionToggles,
  RoleCreateForm,
  RoleNameForm,
  SlowmodeField,
} from '../settings_fields'
import { dangerBtn, fieldCls, Masked, textBtn } from '../ui'
import { MemberAvatar } from './p2p_badge'

// Roles and channel permissions of a P2P server: the role editor (drag order,
// names, colors, permission toggles), a member's roles (menu and card), and a channel's
// restrictions, allow list and slow mode, on the controls instance servers use. Every change is a
// signed event members check against the rules.

const can = (v: ServerView, bit: number) => v.me === 'join' && (v.perms & bit) !== 0

// Who can still see or send in a restricted channel nobody is let into.
const NOBODY = 'owners and members with Manage channels'
const NO_COLOR = '#99aab5'

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs text-on-surface-variant">{children}</p>
)

const swatch = (c: number | null) => ({ backgroundColor: hex(c) ?? 'var(--color-outline)' })

// Keeps a press on a field inside a draggable row from starting a drag or the row's menu.
const stop = (e: SyntheticEvent) => e.stopPropagation()
const keepPress = { onPointerDown: stop, onTouchStart: stop, onContextMenu: stop }

// Toggles of a role's bits: a turned-on bit needs it ourselves (role_bits).
const bitChecks = (identity: P2pApp) => (v: ServerView, role: string, value: number) => {
  const { p2pServer } = identity
  return {
    value,
    allowed: (next: number) => (next & ~value & ~v.perms) === 0,
    onChange: (next: number) => {
      const bit = next ^ value
      void p2pServer.setRoleBit(v.id, role, bit, (next & bit) !== 0)
    },
  }
}

const rows = (
  target: Target,
  acct = client.shown(),
  identity = acct.identities.viewed() ?? null
) => {
  registerAppActions()
  return menuItems(ctxFor(acct.store.getState(), target, 'menu', acct, identity))
}

// A role's menu (right-click, long-press): move it a step, or delete it.
export const roleItems = (
  v: ServerView,
  r: RoleView,
  acct = client.shown(),
  identity = acct.identities.viewed() ?? null
) => rows({ kind: 'p2p_role', v, r }, acct, identity)

function RoleRow({ v, r }: { v: ServerView; r: RoleView }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer } = identity

  const acct = useAccount()

  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  const edit = can(v, P.ManageRoles) && r.below
  const locked = !can(v, P.ManageRoles) ? 'Needs Manage roles' : r.below ? null : ROLE_LOCKED
  const fixed = v.roles.filter(x => !x.below).length
  const menu = (x: number, y: number) =>
    openActionMenu(x, y, { kind: 'p2p_role', v, r }, undefined, acct, identity)
  const handle = edit
    ? longPress(menu, {
        group: 'p2p-roles',
        key: r.id,
        zones: z => z === 'p2p-roles',
        onDrop: ({ index }) =>
          peerServer
            .forIdentity(identity)
            .moveRoles(
              v,
              placeRole(v.roles, r.id, fixed + index, v.rank, p2p.limits().server),
              acct
            ),
      })
    : longPress(menu)
  return (
    <div
      data-drag-box
      data-p2p-role={r.name}
      className="space-y-1.5 rounded-xl bg-surface-container p-2"
    >
      <div {...handle} className="flex min-h-9 items-center gap-2">
        {edit && (
          <span
            title="Drag to reorder"
            aria-hidden
            className="flex shrink-0 cursor-grab text-on-surface-variant"
          >
            <GripVertical size={16} />
          </span>
        )}
        {edit ? (
          <span {...keepPress} className="flex min-w-0 flex-1 items-center gap-2">
            <ColorSwatch
              initial={hex(r.color) ?? NO_COLOR}
              onCommit={c =>
                void p2pServer.editRole(v.id, r.id, { name: r.name, color: fromHex(c) })
              }
            />
            <RoleNameForm
              initial={r.name}
              maxLength={p2p.limits().server.roleNameMax}
              onRename={name => void p2pServer.editRole(v.id, r.id, { name, color: r.color })}
            />
          </span>
        ) : (
          <>
            <span aria-hidden className="h-5 w-5 shrink-0 rounded-full" style={swatch(r.color)} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              <Masked text={r.name} own={own} />
            </span>
          </>
        )}
        {edit && (!r.held || can(v, P.ManageChannels)) && (
          <button
            onClick={() => peerServer.forIdentity(identity).deleteRole(v, r, acct)}
            aria-label={`Delete ${mask(r.name)}`}
            title={`Delete ${mask(r.name)}`}
            className={dangerBtn}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      <p className="text-xs text-on-surface-variant">
        {r.holders} {r.holders === 1 ? 'member' : 'members'}
      </p>
      <PermChecks items={PERM_ITEMS} locked={locked} {...bitChecks(identity)(v, r.id, r.bits)} />
      {locked && can(v, P.ManageRoles) && <Note>{locked}</Note>}
    </div>
  )
}

function RolesTabBody({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer } = identity

  const edit = can(v, P.ManageRoles)
  const fixed = v.roles.filter(r => !edit || !r.below)
  const movable = edit ? v.roles.filter(r => r.below) : []
  // @everyone ranks lowest: anyone ranked with Manage roles may change it.
  const everyoneLocked = !edit ? 'Needs Manage roles' : v.rank[0] > -1 ? null : ROLE_LOCKED
  return (
    <div className="flex flex-col gap-2">
      {fixed.map(r => (
        <RoleRow key={r.id} v={v} r={r} />
      ))}
      <div ref={dragScope}>
        <div data-drop-zone="p2p-roles" className="flex flex-col gap-2">
          {movable.map(r => (
            <RoleRow key={r.id} v={v} r={r} />
          ))}
        </div>
      </div>
      <div data-p2p-role="@everyone" className="space-y-1.5 rounded-xl bg-surface-container p-2">
        <div className="flex min-h-9 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">@everyone</span>
          <span className="shrink-0 text-xs text-on-surface-variant">Every member</span>
        </div>
        <PermChecks
          items={EVERYONE_ITEMS}
          locked={everyoneLocked}
          {...bitChecks(identity)(v, EVERYONE, v.everyone)}
        />
      </div>
      {edit && (
        <>
          <RoleCreateForm
            maxLength={p2p.limits().server.roleNameMax}
            onCreate={(name, color) =>
              p2pServer.createRole(v.id, { name, color: fromHex(color), bits: 0 })
            }
          />
          <Note>
            Members get the permissions of all their roles; their highest role decides who they can
            act on. You can only change roles below your highest one.
          </Note>
        </>
      )}
    </div>
  )
}

// ----- A member's roles -----

// The roles we may give or take, as the member menu's Roles submenu lists them.
export const roleMenuItems = (
  v: ServerView,
  m: MemberView,
  acct = client.shown(),
  identity = acct.identities.viewed() ?? null
) => {
  registerAppActions()
  const ctx = ctxFor(acct.store.getState(), { kind: 'p2p_member', v, m }, 'menu', acct, identity)
  return itemFor('p2p_member_roles', ctx)?.submenu ?? []
}

// The card on top of a member's menu: who they are and their roles, each removable where we may.
function MemberCardBody({ room, ik }: { room: string; ik: string }) {
  const identity = useP2pApp()!

  const acct = useAccount()

  const v = useP2p(s => s.servers[room])
  const me = useP2p(s => s.me)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  const m = v?.members.find(x => x.ik === ik)
  if (!v || !m) return null
  const roles = m.roles.flatMap(id => v.roles.find(r => r.id === id) ?? [])
  const self = m.ik === me
  const bio = shownBio({ username: m.ik }, { server_bio: m.bio })
  // Under a server name, the name they give themselves everywhere.
  const global = m.nick !== undefined && m.nick === m.name ? identity.profileName(m.ik, room) : null
  return (
    <div data-p2p-member-card className="flex flex-col gap-2 py-1">
      {m.bn && (
        <div
          aria-hidden
          data-p2p-member-banner
          className="h-8 rounded-lg"
          style={{
            background: shownBanner(
              {
                username: m.ik,
                avatar_kind: m.av?.kind ?? 'identicon',
                avatar_color: m.av?.bg ?? null,
              },
              { server_banner: m.bn }
            ),
          }}
        />
      )}
      <div className="flex items-center gap-2.5">
        <MemberAvatar members={v.members} ik={m.ik} size={40} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className="streamer truncate text-sm font-semibold"
            style={{ color: hex(nameColor(m, v.roles)) }}
          >
            <Masked text={m.name} own={self} />
          </span>
          {global && global !== m.name && (
            <span data-p2p-member-global className="streamer truncate text-xs">
              <Masked text={global} own={self} />
            </span>
          )}
          <span className="text-xs text-on-surface-variant">
            {m.owner ? 'Owner' : m.m === 'join' ? 'Member' : 'Invited'}
          </span>
        </span>
        {m.owner && (
          <span title="Owner" aria-label="Owner" role="img" className="flex text-tertiary">
            <Crown size={14} />
          </span>
        )}
      </div>
      {bio && (
        <p
          data-p2p-member-bio
          className="streamer text-xs break-words whitespace-pre-wrap text-on-surface"
        >
          <Masked text={bio} own={self} />
        </p>
      )}
      {m.profileLocked && m.resetProfile && (
        <p data-p2p-member-locked className="text-xs text-on-surface-variant">
          Server profile locked
        </p>
      )}
      {roles.length > 0 && (
        <ul aria-label="Roles" className="flex flex-wrap gap-1">
          {roles.map(r => (
            <li
              key={r.id}
              data-p2p-role-chip={r.name}
              className="flex items-center gap-1 rounded-full bg-surface-container-highest py-0.5 pr-1 pl-2 text-xs"
            >
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={swatch(r.color)} />
              <Masked text={r.name} own={own} />
              {mayTakeRole(v, m, r, me) ? (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    peerServer.forIdentity(identity).takeRole(v, m, r, acct)
                  }}
                  title={`Remove ${mask(r.name)}`}
                  aria-label={`Remove ${mask(r.name)}`}
                  className="rounded-full p-0.5 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
                >
                  <X size={12} />
                </button>
              ) : (
                <span className="w-1" />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ----- A channel's permissions -----

const mayWrite = mayWriteRow

// A subject's name as text (labels): @everyone, the role's (`maskRole`) or the member's (`mask`,
// never your own).
const subjectText =
  (identity: P2pApp) =>
  (
    streamer: boolean,
    v: ServerView,
    subj: string,
    me: string | null,
    maskRole: (t: string) => string,
    mask: (t: string) => string
  ) => {
    const { memberName } = identity
    return subj === `r:${EVERYONE}`
      ? '@everyone'
      : subj.startsWith('r:')
        ? maskRole(v.roles.find(x => `r:${x.id}` === subj)?.name ?? 'Deleted role')
        : streamer
          ? 'this member'
          : subj === `u:${me}`
            ? memberName(v.id, subj.slice(2))
            : mask(memberName(v.id, subj.slice(2)))
  }

function SubjectName({ v, subj }: { v: ServerView; subj: string }) {
  const identity = useP2pApp()!
  const { memberName } = identity

  const own = useP2p(s => ownsP2pServer(v, s.me))
  const me = useP2p(s => s.me)
  if (subj === `r:${EVERYONE}`)
    return <span className="min-w-0 flex-1 truncate text-sm">@everyone</span>
  if (subj.startsWith('r:')) {
    const r = v.roles.find(x => `r:${x.id}` === subj)
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={swatch(r?.color ?? null)}
        />
        <span className="truncate">
          <Masked text={r?.name ?? 'Deleted role'} own={own} />
        </span>
      </span>
    )
  }
  const ik = subj.slice(2)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
      <MemberAvatar members={v.members} ik={ik} size={20} />
      <span className="streamer truncate">
        <Masked text={memberName(v.id, ik)} own={ik === me} />
      </span>
    </span>
  )
}

// Members to add to an allow list: searched by name, 50 at a time.
function MemberPickerBody({
  people,
  onPick,
}: {
  people: MemberView[]
  onPick: (m: MemberView) => void
}) {
  const me = useP2p(s => s.me)
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const found = matching(people, q, m => m.name)
  const { items, more } = page(found, shown)
  return (
    <div data-p2p-member-picker className="flex flex-col gap-1">
      <input
        value={q}
        onChange={e => {
          setQ(e.target.value)
          setShown(PAGE)
        }}
        placeholder="Search members"
        aria-label="Search members"
        className={fieldCls}
      />
      <ul aria-label="Members" className="max-h-48 overflow-y-auto rounded-lg bg-surface-container">
        {items.map(m => (
          <li key={m.ik}>
            <button
              onClick={() => onPick(m)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-surface-container-highest"
            >
              <MemberAvatar members={items} ik={m.ik} size={24} />
              <span className="streamer min-w-0 truncate">
                <Masked text={m.name} own={m.ik === me} />
              </span>
            </button>
          </li>
        ))}
        {found.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-on-surface-variant">No matching members.</li>
        )}
      </ul>
      {more && (
        <button
          onClick={() => setShown(n => nextPage(n, found.length))}
          className={`${textBtn} self-start`}
        >
          Show more
        </button>
      )}
    </div>
  )
}

function ChannelAccessBody({ v, c }: { v: ServerView; c: ChannelView }) {
  const identity = useP2pApp()!
  const { p2pServer } = identity

  const [role, setRole] = useState('')
  const streamer = useStore(s => s.streamer)
  const [picking, setPicking] = useState(false)
  const me = useP2p(s => s.me)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const maskRole = useMask(own)
  const mask = useMask()
  const rows = Object.entries(c.over).filter(
    ([subj]) => subj.startsWith('r:') || subj.startsWith('u:')
  )
  const listed = (subj: string) => rows.some(([s]) => s === subj)
  const allow = (subj: string) => void p2pServer.setOverwrite(v.id, c.id, subj, ALLOW_BOTH)
  // A voice channel is only joined or not (View channels): no send rules, no slow mode.
  const voice = c.kind === 'voice'
  const restricted = !!c.restrict_view || (!voice && !!c.restrict_send)
  const roles = v.roles.filter(r => r.below && !listed(`r:${r.id}`))
  const people = v.members
    .filter(m => m.m === 'join' && m.below && !m.owner && !listed(`u:${m.ik}`))
    .sort((a, b) => a.name.localeCompare(b.name))
  const toggle = (key: RestrictKey) =>
    void p2pServer.editChannel(
      v.id,
      c.id,
      key === 'restrict_view'
        ? { restrict_view: !c.restrict_view }
        : { restrict_send: !c.restrict_send }
    )
  return (
    <div data-p2p-channel-access className="space-y-2 rounded-xl bg-surface-container-low p-2">
      <RestrictionToggles nobody={NOBODY} value={c} onToggle={toggle} send={!voice} />
      <p className="pt-1 text-xs font-medium text-on-surface-variant">
        {allowListTitle(restricted)}
      </p>
      {rows.length === 0 && (
        <Note>{emptyAllowText(!!c.restrict_view, !voice && !!c.restrict_send, NOBODY)}</Note>
      )}
      {rows.map(([subj, o]) => {
        const f = overFlags(o)
        const off = !mayWrite(v, subj)
        const set = (view: boolean, send: boolean) =>
          void p2pServer.setOverwrite(v.id, c.id, subj, overBits(view, send))
        const name = subjectText(identity)(streamer, v, subj, me, maskRole, mask)
        return (
          <div
            key={subj}
            data-p2p-over={subj}
            title={off ? ROLE_LOCKED : undefined}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${off ? 'opacity-60' : ''}`}
          >
            <SubjectName v={v} subj={subj} />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={f.view}
                disabled={off}
                onChange={() => set(!f.view, f.send)}
                className="accent-primary"
              />
              View
            </label>
            {!voice && (
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={f.send}
                  disabled={off}
                  onChange={() => set(f.view, !f.send)}
                  className="accent-primary"
                />
                Send
              </label>
            )}
            <button
              onClick={() => void p2pServer.setOverwrite(v.id, c.id, subj, { allow: 0, deny: 0 })}
              disabled={off}
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest hover:text-error disabled:pointer-events-none"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-2">
        {roles.length > 0 && (
          <span className="flex min-w-0 flex-1 gap-2">
            <select
              value={role}
              onChange={e => setRole(e.target.value)}
              title="Add role"
              aria-label="Add role"
              className={fieldCls}
            >
              <option value="">Add role…</option>
              {roles.map(r => (
                <option key={r.id} value={`r:${r.id}`}>
                  {maskRole(r.name)}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (!role || listed(role)) return
                allow(role)
                setRole('')
              }}
              className={textBtn}
            >
              Add
            </button>
          </span>
        )}
        {people.length > 0 && (
          <button onClick={() => setPicking(p => !p)} aria-expanded={picking} className={textBtn}>
            Add member
          </button>
        )}
      </div>
      {picking && people.length > 0 && (
        <MemberPicker
          people={people}
          onPick={m => {
            allow(`u:${m.ik}`)
            setPicking(false)
          }}
        />
      )}
      {!voice && (
        <SlowmodeField
          current={c.slow ?? 0}
          onApply={n => void p2pServer.editChannel(v.id, c.id, { slow: n })}
        />
      )}
    </div>
  )
}

export const RolesTab = withP2pIdentity(RolesTabBody)
export const MemberCard = withP2pIdentity(MemberCardBody)
export const MemberPicker = withP2pIdentity(MemberPickerBody)
export const ChannelAccess = withP2pIdentity(ChannelAccessBody)
