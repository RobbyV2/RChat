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
  ROLE_LOCKED,
  fromHex,
  hex,
  mayTakeRole,
  mayWriteRow,
  nameColor,
  placeRole,
  shownOrder,
  subjectName,
} from '../../lib/p2p/roles'
import { RULES_NEXT } from '../../lib/p2p/acl/rules'
import { fromWire } from '../../lib/perms'
import {
  NO_GRANT,
  bitsBlock,
  everyoneItems,
  p2pMaskIn,
  permItems,
  type RuleSource,
} from '../../lib/perm_source'
import { subjectNames, syncConfirmText } from '../../lib/categories'
import { usePermissionRules } from '../use_permission_rules'
import { RuleEditor } from '../rule_editor'
import { PermGroups } from '../perm_groups'
import {
  FollowButton,
  RoleTabs,
  ShownRow,
  keyMoves,
  type RolesTab as RolesTabKind,
} from '../role_order_tools'
import { PeerActorTag } from '../view_actor'
import { EVERYONE, P } from '../../lib/p2p/state'
import { shownBanner, shownBio } from '../../lib/server_profile'
import type {
  CategoryView,
  ChannelView,
  MemberView,
  RoleView,
  ServerView,
} from '../../lib/p2p/server'
import { allowListTitle, emptyAllowText, type RestrictKey } from '../../lib/channel_access'
import { matching, nextPage, page, PAGE } from '../../lib/paging'
import { longPress } from '../context_menu'
import { Row, Stack, Surface } from '../layout'
import { dragScope } from '../drag'
import {
  ColorSwatch,
  RestrictionToggles,
  RoleCreateForm,
  RoleNameForm,
  SlowmodeField,
} from '../settings_fields'
import { dangerBtn, Dialog, fieldCls, Masked, textBtn } from '../ui'
import { PeerTimeoutBadge } from '../timeout_dialog'
import { MemberAvatar } from './p2p_badge'
import { RoleLooksFields } from '../role_looks_fields'
import { roleIcon } from '../../lib/role_looks'

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

// A role's or @everyone's permission switches: a turned-on bit needs it ourselves (role_bits),
// from rules 5 as the shared rules check it.
const bitSwitches = (identity: P2pApp) => (v: ServerView, role: string, value: number) => {
  const { p2pServer } = identity
  const rules = v.rules
  const own = ownsP2pServer(v, identity.useP2p.getState().me)
  return {
    value,
    blockOf: (next: number) =>
      rules >= RULES_NEXT
        ? bitsBlock(fromWire(v.perms, rules), own, fromWire(value, rules), fromWire(next, rules))
        : (next & ~value & ~v.perms) === 0
          ? null
          : NO_GRANT,
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

// What a row of a role's menu does, when the row is there.
const roleAction = (
  id: string,
  v: ServerView,
  r: RoleView,
  acct = client.shown(),
  identity = acct.identities.viewed() ?? null
) => {
  registerAppActions()
  return itemFor(
    id,
    ctxFor(acct.store.getState(), { kind: 'p2p_role', v, r }, 'menu', acct, identity)
  )?.action
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
  const [open, setOpen] = useState(false)
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
  const items = permItems(v.rules)
  return (
    <div
      data-drag-box
      data-p2p-role={r.name}
      aria-label={mask(r.name)}
      {...keyMoves(
        () => roleAction('p2p_role_up', v, r, acct, identity),
        () => roleAction('p2p_role_down', v, r, acct, identity)
      )}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Surface pad="sm" gap="xs" tone="base" radius="lg">
        <div {...handle} className="flex min-h-9">
          <Row gap="sm" place="flex-1">
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
              <Row as="span" {...keepPress} gap="sm" place="flex-1">
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
              </Row>
            ) : (
              <>
                <span
                  aria-hidden
                  className="h-5 w-5 shrink-0 rounded-full"
                  style={swatch(r.color)}
                />
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
          </Row>
        </div>
        <Row gap="sm">
          <p className="min-w-0 flex-1 text-xs text-on-surface-variant">
            {r.holders} {r.holders === 1 ? 'member' : 'members'}
          </p>
          <button
            type="button"
            {...keepPress}
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className={textBtn}
          >
            {open ? 'Hide permissions' : 'Permissions'}
          </button>
        </Row>
        {open && (
          <span {...keepPress} className="block">
            <PermGroups items={items} locked={locked} {...bitSwitches(identity)(v, r.id, r.bits)} />
          </span>
        )}
        <span {...keepPress} className="block">
          <RoleLooksFields
            name={mask(r.name)}
            icon={roleIcon(r.icon)}
            hoist={r.hoist}
            tint={r.tint}
            locked={locked}
            onChange={patch => void p2pServer.editRole(v.id, r.id, patch)}
          />
        </span>
        {locked && can(v, P.ManageRoles) && <Note>{locked}</Note>}
      </Surface>
    </div>
  )
}

function RolesTabBody({ v }: { v: ServerView }) {
  const identity = useP2pApp()!
  const { p2p, p2pServer, memberName } = identity
  const acct = useAccount()
  const ready = usePermissionRules()
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const mask = useMask(own)
  const [tab, setTab] = useState<RolesTabKind>('rank')
  const edit = can(v, P.ManageRoles)
  const fixed = v.roles.filter(r => !edit || !r.below)
  const movable = edit ? v.roles.filter(r => r.below) : []
  // @everyone ranks lowest: anyone ranked with Manage roles may change it.
  const everyoneLocked = !edit ? 'Needs Manage roles' : v.rank[0] > -1 ? null : ROLE_LOCKED
  if (!ready) return null
  const rules = v.rules
  const owners = v.owners.length ? v.owners : v.owner ? [v.owner] : []
  const shown = shownOrder(v.roles).flatMap(id => v.roles.find(r => r.id === id) ?? [])
  const anyRole = v.roles[0]
  return (
    <Stack gap="sm">
      <RoleTabs tab={tab} onTab={setTab} />
      {owners.length > 0 && (
        <Surface data-p2p-owners pad="sm" tone="base" radius="lg">
          <Row gap="sm">
            <span title="Owners" aria-hidden className="flex shrink-0 text-tertiary">
              <Crown size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">Owners</span>
              <span className="streamer truncate text-xs text-on-surface-variant">
                {owners.map(ik => memberName(v.id, ik)).join(', ')}
              </span>
            </span>
            <span className="shrink-0 text-xs text-on-surface-variant">Every permission</span>
          </Row>
        </Surface>
      )}
      {tab === 'rank' ? (
        <>
          {fixed.map(r => (
            <RoleRow key={r.id} v={v} r={r} />
          ))}
          <div ref={dragScope}>
            <Stack data-drop-zone="p2p-roles" gap="sm">
              {movable.map(r => (
                <RoleRow key={r.id} v={v} r={r} />
              ))}
            </Stack>
          </div>
          <Surface data-p2p-role="@everyone" pad="sm" gap="xs" tone="base" radius="lg">
            <div className="flex min-h-9">
              <Row gap="sm" place="flex-1">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">@everyone</span>
                <span className="shrink-0 text-xs text-on-surface-variant">Every member</span>
              </Row>
            </div>
            <PermGroups
              items={everyoneItems(rules)}
              locked={everyoneLocked}
              {...bitSwitches(identity)(v, EVERYONE, v.everyone)}
            />
          </Surface>
          {edit && (
            <>
              <RoleCreateForm
                maxLength={p2p.limits().server.roleNameMax}
                onCreate={(name, color) =>
                  p2pServer.createRole(v.id, { name, color: fromHex(color), bits: 0 })
                }
              />
              <Note>
                Members get the permissions of all their roles; their highest role decides who they
                can act on. You can only change roles below your highest one. Drag a role, or press
                Alt+Up and Alt+Down on it, to move it.
              </Note>
            </>
          )}
        </>
      ) : (
        <>
          {anyRole && (
            <FollowButton run={roleAction('p2p_role_show_ranked', v, anyRole, acct, identity)} />
          )}
          {shown.map(r => (
            <ShownRow
              key={r.id}
              name={<Masked text={r.name} own={own} />}
              swatch={hex(r.color)}
              up={{
                text: `Show ${mask(r.name)} higher`,
                run: roleAction('p2p_role_show_up', v, r, acct, identity),
              }}
              down={{
                text: `Show ${mask(r.name)} lower`,
                run: roleAction('p2p_role_show_down', v, r, acct, identity),
              }}
              menu={longPress((x, y) =>
                openActionMenu(x, y, { kind: 'p2p_role', v, r }, undefined, acct, identity)
              )}
            />
          ))}
          <Note>The member list shows roles in this order. Role order still decides rank.</Note>
        </>
      )}
    </Stack>
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
    <Surface data-p2p-member-card pad="2xs" gap="sm" tone="plain" radius="none">
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
      <Row gap="sm">
        <MemberAvatar members={v.members} ik={m.ik} size={40} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className="streamer truncate text-sm font-semibold"
            style={{ color: nameColor(m, v.roles) }}
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
        {(m.ik === me || can(v, P.TimeoutMembers)) && <PeerTimeoutBadge m={m} />}
        {m.owner && (
          <span title="Owner" aria-label="Owner" role="img" className="flex text-tertiary">
            <Crown size={14} />
          </span>
        )}
      </Row>
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
    </Surface>
  )
}

// ----- A channel's permissions -----

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
      <Row as="span" gap="xs" place="flex-1">
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={swatch(r?.color ?? null)}
        />
        <span className="truncate text-sm">
          <Masked text={r?.name ?? 'Deleted role'} own={own} />
        </span>
      </Row>
    )
  }
  const ik = subj.slice(2)
  return (
    <Row as="span" gap="xs" place="flex-1">
      <MemberAvatar members={v.members} ik={ik} size={20} />
      <span className="streamer truncate text-sm">
        <Masked text={memberName(v.id, ik)} own={ik === me} />
      </span>
    </Row>
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
    <Stack data-p2p-member-picker gap="2xs">
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
          <Surface as="li" pad="sm" tone="plain" radius="none">
            <span className="text-sm text-on-surface-variant">No matching members.</span>
          </Surface>
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
    </Stack>
  )
}

// A channel's overwrites, switches and slow mode, or a category's overwrites (which reach the
// channels synced with it), in the shared rule editor.
function ChannelAccessBody({
  v,
  c: channel,
  cat,
}: {
  v: ServerView
  c?: ChannelView
  cat?: CategoryView
}) {
  const identity = useP2pApp()!
  const { p2pServer } = identity
  const acct = useAccount()
  const ready = usePermissionRules()
  const streamer = useStore(s => s.streamer)
  const [picking, setPicking] = useState(false)
  const me = useP2p(s => s.me)
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const maskRole = useMask(own)
  const mask = useMask()
  if (!ready) return null
  const over = (channel ?? cat)?.over ?? ({} as ChannelView['over'])
  const id = channel?.id ?? cat?.id ?? ''
  const rules = v.rules
  const voice = channel?.kind === 'voice'
  const write = (subj: string, o: { allow: number; deny: number }) =>
    channel
      ? p2pServer.setOverwrite(v.id, id, subj, o)
      : p2pServer.setCategoryOverwrite(v.id, id, subj, o)
  const everyone = `r:${EVERYONE}`
  const held = v.members.find(m => m.ik === me)?.roles ?? []
  const maskIn = (o: ChannelView['over'], c: ChannelView | undefined) =>
    p2pMaskIn(
      v.perms,
      own,
      held,
      me ?? '',
      o,
      { restrictView: c?.restrict_view === true, restrictSend: c?.restrict_send === true },
      rules
    )
  const src: RuleSource = {
    ruleset: rules,
    place: channel ? (voice ? 'voice' : 'text') : 'category',
    everyone,
    rows: Object.entries(over)
      .filter(([subj]) => subj.startsWith('r:') || subj.startsWith('u:'))
      .map(([subject, o]) => ({ subject, allow: o.allow, deny: o.deny, merge: false })),
    canonical: bits => fromWire(bits, rules),
    mine: maskIn(over, channel),
    also: cat ? v.channels.filter(c => c.cat === cat.id && c.sync).map(c => maskIn(c.over, c)) : [],
    exempt: rules < RULES_NEXT || own,
    subjectOk: subj => mayWriteRow(v, subj),
    lock: subj => (mayWriteRow(v, subj) ? null : ROLE_LOCKED),
    merges: false,
    write: (subj, o) => write(subj, o),
    clear: subj => write(subj, { allow: 0, deny: 0 }),
    everyoneBits: v.everyone ?? 0,
    roleBits: Object.fromEntries((v.roles ?? []).map(r => [`r:${r.id}`, r.bits])),
    memberRoles: subj =>
      (v.members.find(m => `u:${m.ik}` === subj)?.roles ?? []).map(r => `r:${r}`),
    memberWho: subj =>
      v.members.find(m => `u:${m.ik}` === subj)?.owner ? { kind: 'owner' } : undefined,
    restrictView: channel?.restrict_view === true,
    restrictSend: channel?.restrict_send === true,
  }
  const listed = (subj: string) => src.rows.some(r => r.subject === subj)
  const label = (subj: string) => subjectText(identity)(streamer, v, subj, me, maskRole, mask)
  const people = v.members
    .filter(m => m.m === 'join' && m.below && !m.owner && !listed(`u:${m.ik}`))
    .sort((a, b) => a.name.localeCompare(b.name))
  const restricted = !!channel?.restrict_view || (!voice && !!channel?.restrict_send)
  const toggle = (key: RestrictKey) =>
    channel &&
    void p2pServer.editChannel(
      v.id,
      id,
      key === 'restrict_view'
        ? { restrict_view: !channel.restrict_view }
        : { restrict_send: !channel.restrict_send }
    )
  const category = channel && v.categories.find(x => x.id === channel.cat)
  const syncNow = async () => {
    if (!channel || !category) return
    const widens = await p2pServer.syncWidens(v.id, id)
    if (widens === null) return
    const go = () => void p2pServer.syncChannel(v.id, id)
    if (!widens.length) return go()
    acct.store.getState().askConfirm({
      title: 'Sync Permissions',
      body: syncConfirmText(
        category.name,
        `#${channel.name}`,
        subjectNames(widens, subj => subjectName(v, subj, mask, streamer))
      ),
      confirm: 'Sync',
      action: go,
    })
  }
  const synced = cat ? v.channels.filter(c => c.cat === cat.id && c.sync).length : 0
  return (
    <Stack data-p2p-channel-access gap="sm">
      <RuleEditor
        src={src}
        label={label}
        render={subj => <SubjectName v={v} subj={subj} />}
        roleOrder={v.roles.map(r => `r:${r.id}`)}
        addable={[
          ...(mayWriteRow(v, everyone) ? [{ subject: everyone, label: '@everyone' }] : []),
          ...v.roles
            .filter(r => r.below)
            .map(r => ({ subject: `r:${r.id}`, label: maskRole(r.name) })),
        ]}
        memberPicker={pick =>
          people.length > 0 && (
            <Stack gap="sm" place="w-full">
              <button
                type="button"
                onClick={() => setPicking(p => !p)}
                aria-expanded={picking}
                className={`${textBtn} self-start`}
              >
                Add member
              </button>
              {picking && (
                <MemberPicker
                  people={people}
                  onPick={m => {
                    pick(`u:${m.ik}`)
                    setPicking(false)
                  }}
                />
              )}
            </Stack>
          )
        }
        empty={
          channel
            ? emptyAllowText(!!channel.restrict_view, !voice && !!channel.restrict_send, NOBODY)
            : undefined
        }
      >
        {channel ? (
          <>
            {category && (
              <div
                data-p2p-sync
                className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant"
              >
                <span className="min-w-0 flex-1">
                  {channel.sync
                    ? `Synced with ${category.name}. Changing a rule here stops it.`
                    : `Not synced with ${category.name}.`}
                </span>
                {!channel.sync && (
                  <button type="button" onClick={() => void syncNow()} className={textBtn}>
                    Sync now
                  </button>
                )}
              </div>
            )}
            <RestrictionToggles nobody={NOBODY} value={channel} onToggle={toggle} send={!voice} />
            <p className="text-xs font-medium text-on-surface-variant">
              {allowListTitle(restricted)}
            </p>
          </>
        ) : (
          <Note>
            {synced === 1
              ? 'Applies to 1 synced channel.'
              : `Applies to ${synced} synced channels.`}
          </Note>
        )}
      </RuleEditor>
      {channel && !voice && (
        <SlowmodeField
          current={channel.slow ?? 0}
          onApply={n => void p2pServer.editChannel(v.id, id, { slow: n })}
        />
      )}
    </Stack>
  )
}

// A channel's or category's permissions as a dialog, from its menu.
function PermsDialogBody({ room, ch, cat }: { room: string; ch?: string; cat?: string }) {
  const identity = useP2pApp()!
  const v = useP2p(s => s.servers[room])
  const c = ch ? v?.channels.find(x => x.id === ch) : undefined
  const g = cat ? v?.categories.find(x => x.id === cat) : undefined
  if (!v || (!c && !g)) return null
  const title = c
    ? `${c.kind === 'voice' ? c.name : `#${c.name}`} permissions`
    : `${g!.name} permissions`
  return (
    <Dialog actor={<PeerActorTag header />} full title={title} onClose={identity.p2p.closeDialog}>
      <ChannelAccess v={v} {...(c ? { c } : { cat: g })} />
    </Dialog>
  )
}

export const RolesTab = withP2pIdentity(RolesTabBody)
export const MemberCard = withP2pIdentity(MemberCardBody)
export const MemberPicker = withP2pIdentity(MemberPickerBody)
export const ChannelAccess = withP2pIdentity(ChannelAccessBody)
export const PermsDialog = withP2pIdentity(PermsDialogBody)
