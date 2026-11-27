'use client'

import { ViewActorTag } from './view_actor'
import { useAccount } from '../lib/client/react'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { GripVertical, Hash, Lock, Trash2, TriangleAlert, Volume2 } from 'lucide-react'
import { registerAppActions } from '../lib/actions'
import { itemFor, openActionMenu, openChoiceMenu } from '../lib/actions/menu'
import { ctxFor } from '../lib/actions/ctx'
import type { Target } from '../lib/actions/types'
import { baseBits, maskXor } from '../lib/perms'
import { droppedOrder } from '../lib/hierarchy'
import { REASON_MAX } from '../lib/reasons'
import { HOSTED } from '../lib/perms'
import { NO_GRANT, bitsBlock, everyoneItems, permItems } from '../lib/perm_source'
import { PermGroups } from './perm_groups'
import { FollowButton, RoleTabs, ShownRow, keyMoves, type RolesTab } from './role_order_tools'
import { dragScope } from './drag'
import { usePermissionRules } from './use_permission_rules'
import {
  changeableRoles,
  errorText,
  memberState,
  myRank,
  serverAdminPerms,
  useStore,
  type ConfirmRequest,
} from '../lib/store'
import {
  NAME_MAX,
  PERM_ITEMS,
  adminMask,
  canGrant,
  canPromote,
  canSetAdminPerms,
  canSetRoleBits,
  REVOKE_RAISES,
  canRevoke,
  passwordDone,
  passwordPrompt,
  movableRoles,
  roleDeleteBlock,
  roleEditBlock,
  rolePerms,
} from '../lib/rules'
import { codeUrl, inviteUrl, sharedByCode } from '../lib/invite'
import { sharing } from '../lib/platform'
import { goingPublic, protectedDetail, publicDetail } from '../lib/joining'
import { readableNow, type PublicRead } from '../lib/public_reading'
import { parseMembersVisible } from '../lib/profile_choice'
import { enterKey } from '../lib/keys'
import { hasBit } from '../lib/perms'
import { ALL_PERMS, Perm, hasPerm } from '../lib/types'
import type {
  Category,
  Channel,
  ConfirmChoice,
  Member,
  Role,
  RoleLimits,
  ServerDetail,
} from '../lib/types'
import { UserAvatar } from './user_avatar'
import { longPress } from './context_menu'
import {
  ColorSwatch,
  PermChecks,
  RoleCreateForm,
  RoleNameForm,
  SlowmodeField,
} from './settings_fields'
import { GuestParticipation, ServerAccessSection, passwordName } from './server_access'
import { HostedMembers, MEMBER_SEARCH_PERMS } from './server_members'
import { WidgetSettings } from './widget_settings'
import { HostedRules } from './perm_dialog'
import { MemberSearchField, useMemberSearch } from './member_search'
import { ColorField } from './color_field'
import { AboutEditor } from './server_about'
import { hostedAbout, hostedAboutPatch } from '../lib/server_about'
import { ServerHeader } from './server_header'
import { SystemMessagesSection } from './system_messages'
import { PlaceProvider, useHostedServer } from '../lib/place/react'
import { ProfilesModeField } from './server_profile_dialog'
import { NameWithUsername } from './display_name'
import { useShownMembers } from './shown_user'
import { ServerUploadExpiry } from './upload_expiry'
import { RoleLooksFields } from './role_looks_fields'
import { hostedShown } from '../lib/role_looks'
import { TopicEditor } from './channel_topic'
import {
  BANNER_PRESETS,
  NAME_PRESETS,
  THEME_ON_SURFACE,
  THEME_SURFACES,
  contrastWarning,
  headerColors,
} from '../lib/server_colors'
import { Row, Stack, Surface } from './layout'
import {
  Dialog,
  FieldError,
  Masked,
  Sentinel,
  dangerBtn,
  fieldCls,
  filledBtn,
  filledDangerBtn,
  sectionCls,
  textBtn,
  useOwnServer,
} from './ui'
import { LabelText } from './instance_badge'
import { endsText } from '../lib/durations'
import { ServerSettingsPage } from './server_settings_page'
import { HostedServer } from '../lib/place/place'
import { type ServerSettingsSection } from '../lib/server_settings_sections'

function HostedSystemMessages({ server }: { server: string }) {
  const place = useHostedServer(server)
  return place && <SystemMessagesSection place={place} />
}

function LockedNote() {
  return (
    <p className="text-xs text-on-surface-variant">
      This admin has permissions you don&apos;t have. You can take permissions away, but you can
      only give permissions you have.
    </p>
  )
}

// Keeps a press on a field of a role row from opening the row's menu.
const stop = (e: SyntheticEvent) => e.stopPropagation()
const keepPress = { onPointerDown: stop, onTouchStart: stop, onContextMenu: stop }

// A role row's menu target: its place in the role order and in the display order, and the
// roles you may move.
const roleTarget = (
  acct: ReturnType<typeof useAccount>,
  server: string,
  role: Role,
  roles: Role[],
  version: number,
  limit: number | undefined,
  limits: RoleLimits | undefined,
  after: () => void
): Target => {
  const s = acct.store.getState()
  const confirmed = s.servers[server]?.roles_order_confirmed === true
  const movable = movableRoles(roles, limit, limits, myRank(s, server), confirmed)
  return {
    kind: 'role',
    server,
    role,
    order: roles.map(r => r.id),
    display: hostedShown(roles).map(r => r.id),
    follows: roles.every(r => r.display_position === null || r.display_position === undefined),
    movable,
    version,
    after,
  }
}

const roleRun = (acct: ReturnType<typeof useAccount>, id: string, target: Target | null) => {
  if (!target) return undefined
  registerAppActions()
  return itemFor(id, ctxFor(acct.store.getState(), target, 'menu', acct))?.action
}

function RoleRow({
  server,
  role,
  roles,
  version,
  refresh,
  limit,
  limits,
}: {
  server: string
  role: Role
  roles: Role[]
  version?: number
  refresh?: () => void
  limit?: number
  limits?: RoleLimits
}) {
  const acct = useAccount()
  const {
    lifetime: { inSession },
  } = acct
  const updateRole = useStore(s => s.updateRole)
  const deleteRole = useStore(s => s.deleteRole)
  const setRoleOrder = useStore(s => s.setRoleOrder)
  const [open, setOpen] = useState(false)
  const after = () => refresh?.()
  const confirmed = useStore(s => s.servers[server]?.roles_order_confirmed === true)
  const target = () =>
    version === undefined
      ? null
      : roleTarget(acct, server, role, roles, version, limit, limits, after)
  const menu = (x: number, y: number) => {
    const t = target()
    if (!t) return
    registerAppActions()
    openActionMenu(x, y, t, undefined, acct)
  }
  const locked = useStore(s =>
    limit === undefined
      ? null
      : roleEditBlock(limit, false, role, limits, myRank(s, server), confirmed)
  )
  const noDelete = useStore(s =>
    limit === undefined
      ? null
      : roleDeleteBlock(limit, false, role, limits, myRank(s, server), confirmed)
  )
  const movable = useStore(
    s =>
      version !== undefined &&
      movableRoles(roles, limit, limits, myRank(s, server), confirmed).includes(role.id)
  )
  const noMention =
    !role.mentionable && limit !== undefined && !hasPerm(limit, Perm.MentionEveryone)
  const press = movable
    ? longPress(menu, {
        group: 'roles',
        key: String(role.id),
        zones: z => z === 'roles',
        onDrop: ({ index }) => {
          const t = target()
          if (!t || t.kind !== 'role') return
          const next = droppedOrder(t.order, t.movable, role.id, index)
          if (next) void setRoleOrder(server, next, t.version).then(inSession(after))
        },
      })
    : longPress(menu)
  return (
    <div
      {...press}
      data-drag-box
      data-role={role.name}
      aria-label={role.name}
      {...keyMoves(
        () => roleRun(acct, 'role_up', target()),
        () => roleRun(acct, 'role_down', target())
      )}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Surface pad="sm" gap="xs" tone="base" radius="lg">
        <Row gap="sm">
          {movable && (
            <span
              title="Drag to reorder"
              aria-hidden
              className="flex shrink-0 cursor-grab text-on-surface-variant"
            >
              <GripVertical size={16} />
            </span>
          )}
          <Row as="span" {...keepPress} gap="sm" place="flex-1">
            <ColorSwatch
              initial={role.color}
              locked={locked}
              onCommit={color => void updateRole(server, role.id, { color }).then(inSession(after))}
            />
            <RoleNameForm
              initial={role.name}
              locked={locked}
              onRename={name => void updateRole(server, role.id, { name }).then(inSession(after))}
            />
          </Row>
          <span title={noDelete ?? `Delete ${role.name}`} className="shrink-0">
            <button
              onClick={() => void deleteRole(server, role.id).then(inSession(after))}
              disabled={!!noDelete}
              aria-label={`Delete ${role.name}`}
              title={noDelete ?? `Delete ${role.name}`}
              className={`${dangerBtn} disabled:pointer-events-none`}
            >
              <Trash2 size={16} />
            </button>
          </span>
        </Row>
        <Row {...keepPress} gap="sm" wrap>
          <label
            title={
              locked ??
              (noMention
                ? 'Needs the Mention everyone and roles permission'
                : 'Members without Mention everyone and roles can mention it too')
            }
            className={`flex min-w-0 flex-1 text-sm ${locked || noMention ? 'opacity-60' : ''}`}
          >
            <Row as="span" gap="xs" place="flex-1">
              <input
                type="checkbox"
                checked={!!role.mentionable}
                disabled={!!locked || noMention}
                onChange={() =>
                  void updateRole(server, role.id, { mentionable: !role.mentionable }).then(
                    inSession(after)
                  )
                }
                className="accent-primary"
              />
              Allow anyone to mention this role
            </Row>
          </label>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className={textBtn}
          >
            {open ? 'Hide permissions' : 'Permissions'}
          </button>
        </Row>
        {open && (
          <span {...keepPress} className="block">
            <PermGroups
              items={permItems(HOSTED)}
              value={role.perms}
              locked={locked}
              blockOf={
                limit === undefined
                  ? undefined
                  : v => (canSetRoleBits(limit, role.perms, v, confirmed) ? null : NO_GRANT)
              }
              onChange={v => void updateRole(server, role.id, { perms: v }).then(inSession(after))}
            />
          </span>
        )}
        <Stack gap="md">
          <span {...keepPress} className="block">
            <RoleLooksFields
              name={role.name}
              icon={role.icon ?? null}
              hoist={role.hoist === true}
              tint={role.color_names !== false}
              locked={locked}
              onChange={({ icon, hoist, tint }) =>
                void updateRole(server, role.id, {
                  ...(icon !== undefined ? { icon } : {}),
                  ...(hoist !== undefined ? { hoist } : {}),
                  ...(tint !== undefined ? { color_names: tint } : {}),
                }).then(inSession(after))
              }
            />
          </span>
          {(locked ?? noDelete) && (
            <p className="text-xs text-on-surface-variant">{locked ?? noDelete}</p>
          )}
        </Stack>
      </Surface>
    </div>
  )
}

// What every member holds, last on the Roles page.
function EveryoneRow({ server, limit }: { server: string; limit?: number }) {
  const {
    lifetime: { inSession },
  } = useAccount()
  const everyone = useStore(s => s.servers[server]?.everyone_perms)
  const mine = useStore(s => s.servers[server]?.my_perms)
  const exempt = useStore(s => {
    const me = s.me
    const m = me ? memberState(s, server, me.username) : null
    return limit === undefined || (m?.is_admin === true && m.perms === 0)
  })
  const setEveryonePerms = useStore(s => s.setEveryonePerms)
  const [open, setOpen] = useState(false)
  const value = everyone ?? baseBits()
  return (
    <Surface data-role="@everyone" pad="sm" gap="xs" tone="base" radius="lg">
      <div className="flex min-h-9 items-center">
        <Row gap="sm" place="flex-1">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">@everyone</span>
          <span className="shrink-0 text-xs text-on-surface-variant">Every member</span>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className={textBtn}
          >
            {open ? 'Hide permissions' : 'Permissions'}
          </button>
        </Row>
      </div>
      {open && (
        <PermGroups
          items={everyoneItems(HOSTED)}
          value={value}
          blockOf={next => bitsBlock(mine ?? limit ?? 0, exempt, value, next)}
          onChange={next =>
            void setEveryonePerms(server, next, maskXor(value, next)).then(inSession(() => {}))
          }
        />
      )}
    </Surface>
  )
}

export function RolesEditor({
  server,
  roles,
  version,
  refresh,
  limit,
  limits,
}: {
  server: string
  roles: Role[]
  version?: number
  refresh?: () => void
  limit?: number
  limits?: RoleLimits
}) {
  const acct = useAccount()
  const ready = usePermissionRules()
  const [tab, setTab] = useState<RolesTab>('rank')
  const confirmed = useStore(s => s.servers[server]?.roles_order_confirmed === true)
  const confirmRoleOrder = useStore(s => s.confirmRoleOrder)
  const after = () => refresh?.()
  if (!ready) return null
  const guarded = version !== undefined && !confirmed
  const first = roles[0]
  const target = (r: Role) =>
    version === undefined ? null : roleTarget(acct, server, r, roles, version, limit, limits, after)
  return (
    <Stack gap="sm">
      {guarded && (
        <Surface data-order-notice pad="md" inset="bar" tone="secondary" radius="lg">
          <Row gap="sm" wrap>
            <span className="min-w-0 flex-1 text-sm">
              Role order now decides who can moderate whom. Check the order, then confirm it.
            </span>
            <button
              type="button"
              onClick={() =>
                void confirmRoleOrder(server, version).then(acct.lifetime.inSession(after))
              }
              className={textBtn}
            >
              Confirm
            </button>
          </Row>
        </Surface>
      )}
      {version !== undefined && <RoleTabs tab={tab} onTab={setTab} />}
      {tab === 'rank' ? (
        <>
          <div ref={dragScope}>
            <Stack data-drop-zone="roles" gap="sm">
              {roles.map(r => (
                <RoleRow
                  key={r.id}
                  server={server}
                  role={r}
                  roles={roles}
                  version={version}
                  refresh={refresh}
                  limit={limit}
                  limits={limits}
                />
              ))}
            </Stack>
          </div>
          {version !== undefined && <EveryoneRow server={server} limit={limit} />}
          <RoleCreate server={server} refresh={refresh} />
          {version !== undefined && (
            <p className="text-xs text-on-surface-variant">
              Drag a role, or press Alt+Up and Alt+Down on it, to move it.
            </p>
          )}
        </>
      ) : (
        <>
          {first && <FollowButton run={roleRun(acct, 'role_show_ranked', target(first))} />}
          {hostedShown(roles)
            .flatMap(x => roles.find(r => r.id === x.id) ?? [])
            .map(r => (
              <ShownRow
                key={r.id}
                name={r.name}
                swatch={r.color || undefined}
                up={{
                  text: `Show ${r.name} higher`,
                  run: roleRun(acct, 'role_show_up', target(r)),
                }}
                down={{
                  text: `Show ${r.name} lower`,
                  run: roleRun(acct, 'role_show_down', target(r)),
                }}
                menu={longPress((x, y) => {
                  const t = target(r)
                  if (!t) return
                  registerAppActions()
                  openActionMenu(x, y, t, undefined, acct)
                })}
              />
            ))}
          <p className="text-xs text-on-surface-variant">
            The member list shows roles in this order. Role order still decides rank.
          </p>
        </>
      )}
    </Stack>
  )
}

function RoleCreate({ server, refresh }: { server: string; refresh?: () => void }) {
  const {
    lifetime: { inSession },
  } = useAccount()
  const createRole = useStore(s => s.createRole)
  return (
    <RoleCreateForm
      onCreate={(name, color) =>
        createRole(server, { name, color, perms: 0 }).then(inSession(() => refresh?.()))
      }
    />
  )
}

function CategoryControls({
  server,
  category,
  synced,
}: {
  server: string
  category: Category
  synced: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <Surface data-category={category.id} pad="sm" gap="xs" tone="plain" radius="lg">
      <Row gap="md" wrap>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{category.name}</span>
        <span className="text-xs text-on-surface-variant">
          {synced === 1 ? '1 synced channel' : `${synced} synced channels`}
        </span>
        <button onClick={() => setOpen(!open)} aria-expanded={open} className={textBtn}>
          {open ? 'Hide permissions' : 'Permissions'}
        </button>
      </Row>
      {open && <HostedRules server={server} target={{ category }} />}
    </Surface>
  )
}

function ChannelSlowmode({ channel, refresh }: { channel: Channel; refresh?: () => void }) {
  const {
    lifetime: { inSession },
  } = useAccount()
  const setSlowmode = useStore(s => s.setSlowmode)
  return (
    <SlowmodeField
      current={channel.slowmode_seconds}
      onApply={n => void setSlowmode(channel.id, n).then(inSession(() => refresh?.()))}
    />
  )
}

function CategoryCreator({ server }: { server: string }) {
  const createCategory = useStore(s => s.createCategory)
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const create = () => {
    if (!trimmed) return
    setName('')
    void createCategory(server, trimmed)
  }
  return (
    <Surface pad="sm" tone="plain" radius="none">
      <Row gap="sm" wrap>
        <input
          value={name}
          maxLength={NAME_MAX}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (enterKey(e)) create()
          }}
          placeholder="Category name"
          aria-label="Category name"
          className={`${fieldCls} min-w-40 flex-1`}
        />
        <button onClick={create} disabled={!trimmed} className={textBtn}>
          Create category
        </button>
      </Row>
    </Surface>
  )
}

export function ChannelControls({
  server,
  channel,
  refresh,
  lead,
}: {
  server: string
  channel: Channel
  refresh?: () => void
  lead?: ReactNode
}) {
  const {
    store,
    lifetime: { inSession },
  } = useAccount()
  const [open, setOpen] = useState(false)
  const [topicOpen, setTopicOpen] = useState(false)
  return (
    <Surface pad="sm" gap="xs" tone="plain" radius="lg">
      <Row gap="sm" wrap>
        {lead ?? (
          <span className="flex min-w-0 flex-1 basis-full text-sm sm:basis-0">
            <Row as="span" gap="xs" place="flex-1">
              {channel.kind === 'voice' ? (
                <Volume2 size={14} className="shrink-0 text-on-surface-variant" />
              ) : (
                <Hash size={14} className="shrink-0 text-on-surface-variant" />
              )}
              <span className="truncate">{channel.name}</span>
              {channel.restrict_view && (
                <span
                  title="Private channel"
                  aria-label="Private channel"
                  role="img"
                  className="flex shrink-0 text-on-surface-variant"
                >
                  <Lock size={12} />
                </span>
              )}
            </Row>
          </span>
        )}
        <label className="flex min-h-11 cursor-pointer items-center text-sm">
          <Row as="span" gap="xs">
            <input
              type="checkbox"
              className="cursor-pointer accent-primary"
              checked={channel.sensitive === true}
              onChange={() =>
                void store
                  .getState()
                  .setChannelSensitive(server, channel.id, !channel.sensitive)
                  .then(inSession(() => refresh?.()))
              }
            />
            Sensitive channel
          </Row>
        </label>
        {channel.kind === 'text' && (
          <label className="flex min-h-11 cursor-pointer items-center text-sm">
            <Row as="span" gap="xs">
              <input
                type="checkbox"
                className="cursor-pointer accent-primary"
                checked={channel.text_only === true}
                onChange={() =>
                  void store
                    .getState()
                    .setChannelTextOnly(server, channel.id, !channel.text_only)
                    .then(inSession(() => refresh?.()))
                }
              />
              Text only
            </Row>
          </label>
        )}
        {channel.kind === 'text' && <ChannelSlowmode channel={channel} refresh={refresh} />}
        <button
          onClick={() => setTopicOpen(!topicOpen)}
          aria-expanded={topicOpen}
          className={textBtn}
        >
          {topicOpen ? 'Hide topic' : 'Topic'}
        </button>
        <button onClick={() => setOpen(!open)} className={textBtn}>
          {open ? 'Hide permissions' : 'Permissions'}
        </button>
      </Row>
      {topicOpen && <TopicEditor server={server} channel={channel} refresh={refresh} />}
      {open && <HostedRules server={server} target={{ channel }} refresh={refresh} />}
    </Surface>
  )
}

interface OptionChoice extends ConfirmChoice {
  option?: { label: string; detail: string }
}

export const WITH_OPTION = '+option'

export const keepGuestsChoices = (choices: ConfirmChoice[], changed: boolean): OptionChoice[] =>
  changed
    ? choices.map(c =>
        c.value === 'keep'
          ? {
              ...c,
              option: {
                label: 'Also keep guest access',
                detail: 'Guests who entered the old password can keep viewing.',
              },
            }
          : c
      )
    : choices

export function ServerPasswordField({
  server,
  hasPassword,
  canRemove,
  publicRead,
  refresh,
}: {
  server: string
  hasPassword: boolean
  canRemove: boolean
  publicRead: PublicRead
  refresh?: () => void
}) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const askConfirm = useStore(s => s.askConfirm)
  const siteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  const settings = useStore(s => s.settings)
  const publicReadable = readableNow(publicRead, false, settings)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  return (
    <>
      <p className={sectionCls}>Password</p>
      <Stack gap="xs">
        <Row
          as="form"
          gap="sm"
          align="stretch"
          onSubmit={e => {
            e.preventDefault()
            const next = password.trim()
            setError(null)
            setDone(null)
            const prompt = passwordPrompt(
              hasPassword,
              next,
              canRemove,
              siteAdmin,
              false,
              goingPublic(settings, publicReadable)
            )
            const changed = hasPassword && next !== ''
            askConfirm({
              ...prompt,
              choices: keepGuestsChoices(prompt.choices, changed),
              action: choice => {
                const members = choice.startsWith('remove') ? 'remove' : 'keep'
                const keepGuests = choice === `keep${WITH_OPTION}`
                api.updateServer(server, { password: next, members, keep_guests: keepGuests }).then(
                  inSession(res => {
                    setPassword('')
                    const guests =
                      changed && members === 'keep'
                        ? keepGuests
                          ? ' Guests kept access.'
                          : ' Guests lost access.'
                        : ''
                    setDone(passwordDone(prompt.confirm, members, res.removed, res.kept) + guests)
                    refresh?.()
                  }),
                  (err: unknown) => setError(errorText(err))
                )
              },
            })
          }}
        >
          <input
            type="password"
            value={password}
            onChange={e => {
              setPassword(e.target.value)
              setDone(null)
            }}
            placeholder={hasPassword ? 'New password (blank clears)' : 'Set a join password'}
            className={fieldCls}
          />
          <button disabled={!password.trim() && !hasPassword} className={filledBtn}>
            {password.trim() ? 'Set' : hasPassword ? 'Clear' : 'Set'}
          </button>
        </Row>
        <FieldError message={error} />
        {done && (
          <p role="status" className="text-xs text-on-surface">
            {done}
          </p>
        )}
        <p className="text-xs text-on-surface-variant">
          {hasPassword
            ? protectedDetail(settings, readableNow(publicRead, true, settings))
            : publicDetail(settings, publicReadable)}
        </p>
      </Stack>
    </>
  )
}

export function ServerAppearance({
  server,
  detail: fetched,
  refresh,
}: {
  server: string
  detail?: ServerDetail
  refresh?: () => void
}) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const detail = useStore(s => s.servers[server]) ?? fetched
  const theme = useStore(s => s.theme)
  const showGear = useStore(s => serverAdminPerms(s, server) !== 0)
  const savedBanner = detail?.banner_color ?? null
  const savedName = detail?.name_color ?? null
  const [banner, setBanner] = useState(savedBanner)
  const [name, setName] = useState(savedName)
  const [seen, setSeen] = useState({ banner: savedBanner, name: savedName })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  if (seen.banner !== savedBanner || seen.name !== savedName) {
    if (banner === seen.banner) setBanner(savedBanner)
    if (name === seen.name) setName(savedName)
    setSeen({ banner: savedBanner, name: savedName })
  }
  if (!detail) return null
  const rchat = server === 'rchat'
  const dirty = banner !== savedBanner || (!rchat && name !== savedName)
  const warning = rchat ? null : contrastWarning(banner, name)
  const auto = headerColors(banner, null)?.fg
  const preview = detail.channels.filter(c => c.kind === 'text').slice(0, 2)
  const edit = (apply: () => void) => {
    apply()
    setDone(false)
    setError(null)
  }
  return (
    <>
      <p className={sectionCls}>Appearance</p>
      <Stack gap="lg">
        <div
          aria-label="Header preview"
          role="img"
          className="w-full max-w-60 overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low"
        >
          <ServerHeader
            preview
            showGear={showGear}
            server={server}
            displayName={detail.display_name}
            bannerColor={banner}
            nameColor={rchat ? null : name}
          />
          <Surface pad="sm" gap="3xs" tone="plain" radius="none" aria-hidden>
            {preview.map(c => (
              <span
                key={c.id}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-on-surface-variant"
              >
                <Hash size={16} className="shrink-0" />
                <span className="truncate">{c.name}</span>
              </span>
            ))}
          </Surface>
        </div>
        <Stack gap="xs">
          <span className="text-sm text-on-surface">Banner color</span>
          <ColorField
            label="Banner color"
            value={banner}
            shown={banner ?? THEME_SURFACES[theme]}
            onChange={c => edit(() => setBanner(c))}
            presets={BANNER_PRESETS}
            defaultNote="Theme color"
            resetLabel="Reset"
          />
        </Stack>
        {!rchat && (
          <Stack gap="xs">
            <span className="text-sm text-on-surface">Name color</span>
            <ColorField
              label="Name color"
              value={name}
              shown={name ?? auto ?? THEME_ON_SURFACE[theme]}
              onChange={c => edit(() => setName(c))}
              presets={NAME_PRESETS}
              defaultNote={banner ? 'Automatic, readable on the banner' : 'Theme color'}
              resetLabel="Reset"
            />
          </Stack>
        )}
        {warning && (
          <Row as="p" role="status" gap="xs" align="start">
            <TriangleAlert size={14} className="mt-px shrink-0 text-error" aria-hidden />
            <span className="text-xs text-error">{warning}</span>
          </Row>
        )}
        <Row gap="sm" wrap>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true)
              setError(null)
              api
                .updateServer(server, {
                  ...(banner !== savedBanner ? { banner_color: banner } : {}),
                  ...(!rchat && name !== savedName ? { name_color: name } : {}),
                })
                .then(
                  inSession(() => {
                    setDone(true)
                    refresh?.()
                  }),
                  (err: unknown) => setError(errorText(err))
                )
                .finally(() => setSaving(false))
            }}
            className={filledBtn}
          >
            {saving ? 'Saving…' : 'Save colors'}
          </button>
          {dirty && !saving && (
            <button
              type="button"
              onClick={() =>
                edit(() => {
                  setBanner(savedBanner)
                  setName(savedName)
                })
              }
              className={textBtn}
            >
              Discard
            </button>
          )}
          {done && !dirty && (
            <span role="status" className="text-xs text-on-surface">
              Colors saved.
            </span>
          )}
        </Row>
        <FieldError message={error} />
      </Stack>
    </>
  )
}

// The About section for a hosted server.
function HostedAbout({ server }: { server: string }) {
  const { api } = useAccount()
  const detail = useStore(s => s.servers[server])
  const own = useOwnServer(server)
  if (!detail) return null
  return (
    <AboutEditor
      seed={server}
      name={detail.display_name}
      color={detail.banner_color}
      about={hostedAbout(detail)}
      editable
      own={own}
      locked=""
      onSave={change => api.updateServer(server, hostedAboutPatch(change))}
    />
  )
}

function StandingInvite({ server, manage }: { server: string; manage: boolean }) {
  const { api, shareOrigin } = useAccount()
  const [link, setLink] = useState<string | null>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const askConfirm = useStore(s => s.askConfirm)
  const mode = useStore(s => s.servers[server]?.join_mode)
  useEffect(() => {
    let active = true
    api.standingInvite(server).then(
      result => {
        if (active) setLink(result ? codeUrl(result.code, shareOrigin) : null)
      },
      (err: unknown) => {
        if (active) setError(errorText(err))
      }
    )
    return () => {
      active = false
    }
  }, [server, mode])
  const change = async (remove: boolean) => {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      if (remove) {
        await api.revokeInvite(server)
        setLink(null)
      } else {
        const invite = await api.renewInvite(server)
        setLink(codeUrl(invite.code, shareOrigin))
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const request = (remove: boolean) => {
    if (!link) return void change(false)
    askConfirm({
      title: remove ? 'Revoke invite link' : 'Replace invite link',
      body: 'The current link will stop working. Members who used it stay.',
      confirm: remove ? 'Revoke' : 'Replace',
      action: () => void change(remove),
    })
  }
  return (
    <>
      <p className={sectionCls}>Invite link</p>
      <Stack gap="xs">
        {link && <input readOnly value={link} aria-label="Invite link" className={fieldCls} />}
        <Row gap="sm" wrap>
          {link && (
            <button
              className={textBtn}
              onClick={() =>
                void sharing()
                  .copyText(link)
                  .then(ok => {
                    if (ok) setCopied(true)
                    else setError("Couldn't copy the link.")
                  })
              }
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
          {manage && link !== undefined && (
            <button className={textBtn} disabled={busy} onClick={() => request(false)}>
              {link ? 'Replace link' : 'Create invite link'}
            </button>
          )}
          {manage && link && (
            <button className={dangerBtn} disabled={busy} onClick={() => request(true)}>
              Revoke link
            </button>
          )}
        </Row>
        <FieldError message={error} />
      </Stack>
    </>
  )
}

function InviteLinkField({ server, hasPassword }: { server: string; hasPassword: boolean }) {
  const [password, setPassword] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { shareOrigin } = useAccount()
  const link = inviteUrl(server, hasPassword ? password : null, shareOrigin)
  const withPassword = hasPassword && password.trim() !== ''
  return (
    <>
      <p className={sectionCls}>Invite</p>
      <Stack gap="xs">
        <Row gap="sm" align="stretch">
          <input
            readOnly
            value={link}
            aria-label="Invite link"
            onFocus={e => e.currentTarget.select()}
            className={`${fieldCls} streamer text-on-surface-variant`}
          />
          <button
            onClick={() => {
              setError(null)
              navigator.clipboard.writeText(link).then(
                () => setCopied(link),
                (err: unknown) => setError(errorText(err))
              )
            }}
            className={filledBtn}
          >
            {copied === link ? 'Copied' : 'Copy'}
          </button>
        </Row>
        <FieldError message={error} />
        {hasPassword && (
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Server password (optional)"
            autoComplete="off"
            aria-label="Include the server password in the link"
            className={`${fieldCls} w-full`}
          />
        )}
        <p className="text-xs text-on-surface-variant">
          {withPassword
            ? 'Anyone with this link joins without typing the password.'
            : hasPassword
              ? 'People with this link are asked for the password. Type it above to include it in the link.'
              : 'Paste this link in a chat to show an invite card.'}
        </p>
      </Stack>
    </>
  )
}

export function AdminPermsEditor({
  server,
  username,
  perms,
  refresh,
  limit,
}: {
  server: string
  username: string
  perms: number
  refresh?: () => void
  limit?: number
}) {
  const {
    lifetime: { inSession },
  } = useAccount()
  const setAdminPerms = useStore(s => s.setAdminPerms)
  const [lastBlocked, setLastBlocked] = useState(false)
  const value = adminMask(perms)
  return (
    <Stack gap="xs">
      <PermChecks
        items={PERM_ITEMS}
        value={value}
        allowed={
          limit === undefined ? undefined : v => v === 0 || canSetAdminPerms(limit, false, perms, v)
        }
        onChange={v => {
          setLastBlocked(v === 0)
          if (v !== 0)
            void setAdminPerms(server, username, v === ALL_PERMS ? 0 : v).then(
              inSession(() => refresh?.())
            )
        }}
      />
      {lastBlocked && (
        <p className="text-xs text-on-surface-variant">
          An admin keeps at least one permission. To take every permission away, remove them as
          admin instead.
        </p>
      )}
      {limit !== undefined && !canGrant(limit, false, value) && <LockedNote />}
    </Stack>
  )
}

export function BanList({ server }: { server: string }) {
  const cache = useStore(s => s.bans[server])
  const loadBans = useStore(s => s.loadBans)
  const unbanMember = useStore(s => s.unbanMember)
  useEffect(() => {
    void loadBans(server, true)
  }, [server, loadBans])
  const more = useCallback(() => void loadBans(server), [server, loadBans])
  const list = cache?.list ?? []
  return (
    <Stack gap="2xs">
      {list.map(b => (
        <Surface key={b.username} pad="sm" inset="bar" tone="plain" radius="lg">
          <Row gap="sm">
            <UserAvatar
              username={b.username}
              avatarKind={b.avatar_kind}
              avatarColor={b.avatar_color}
              size={28}
            />
            <span className="min-w-0 flex-1 text-sm">
              <span className="block truncate">
                <span className="streamer">
                  <Masked text={b.display_name} by={b.username} />
                </span>
                <span className="text-xs text-on-surface-variant">
                  {' '}
                  · banned {new Date(b.banned_at * 1000).toLocaleDateString()}
                </span>
              </span>
              {(b.expires_at || b.reason) && (
                <span className="block text-xs break-words text-on-surface-variant">
                  {[b.expires_at ? `Ends ${endsText(b.expires_at * 1000)}` : '', b.reason ?? '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </span>
            <button onClick={() => void unbanMember(server, b.username)} className={textBtn}>
              Unban
            </button>
          </Row>
        </Surface>
      ))}
      {cache && !cache.loading && list.length === 0 && (
        <Surface pad="sm" inset="bar" tone="plain" radius="none">
          <p className="text-sm text-on-surface-variant">No one is banned.</p>
        </Surface>
      )}
      {(cache?.hasMore ?? false) && <Sentinel key={list.length} onVisible={more} />}
    </Stack>
  )
}

export function ConfirmDialog() {
  const request = useStore(s => s.confirm)
  const seq = useStore(s => s.confirmSeq)
  const closeConfirm = useStore(s => s.closeConfirm)
  if (!request) return null
  return <ConfirmBody key={seq} request={request} onClose={closeConfirm} />
}

function ConfirmBody({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const { title, body, confirm, action, choices } = request
  const name = useId()
  const [choice, setChoice] = useState(choices?.[0]?.value ?? '')
  const [reason, setReason] = useState('')
  const [optionOn, setOptionOn] = useState(false)
  const picked: OptionChoice | undefined = choices?.find(c => c.value === choice)
  const danger = picked?.danger ?? true
  return (
    <Dialog title={title} onClose={onClose} layer="confirm">
      <Stack gap="xl">
        <Stack gap="lg">
          <p className="text-sm text-on-surface-variant">
            <LabelText text={body} name={request.bodyName} />
          </p>
          {choices && (
            <Stack as="fieldset" gap="sm">
              <legend className="sr-only">{title}</legend>
              {choices.map((c: OptionChoice) => (
                <div
                  key={c.value}
                  className={`rounded-xl border ${
                    c.value === choice
                      ? 'border-primary bg-surface-container-highest'
                      : 'border-outline-variant hover:bg-surface-container-highest'
                  }`}
                >
                  <Surface
                    as="label"
                    pad="md"
                    inset="bar"
                    gap="md"
                    row
                    tone="plain"
                    radius="none"
                    align="stretch"
                    look="cursor-pointer"
                  >
                    <input
                      type="radio"
                      name={name}
                      value={c.value}
                      checked={c.value === choice}
                      onChange={() => setChoice(c.value)}
                      className="mt-0.5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-on-surface">{c.label}</span>
                      <span className="block pt-0.5 text-xs text-on-surface-variant">
                        {c.detail}
                      </span>
                    </span>
                  </Surface>
                  {c.option && c.value === choice && (
                    <label className="flex cursor-pointer gap-3 border-t border-outline-variant py-2.5 pr-3 pl-9">
                      <input
                        type="checkbox"
                        checked={optionOn}
                        onChange={e => setOptionOn(e.target.checked)}
                        className="mt-0.5 shrink-0 accent-primary"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-on-surface">{c.option.label}</span>
                        <span className="block pt-0.5 text-xs text-on-surface-variant">
                          {c.option.detail}
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              ))}
            </Stack>
          )}
        </Stack>
        {request.reason && (
          <Stack as="label" gap="2xs">
            <span className="text-sm text-on-surface-variant">Reason</span>
            <input
              value={reason}
              onChange={e => setReason(e.target.value)}
              maxLength={REASON_MAX}
              placeholder="Optional"
              aria-label="Reason"
              className={`${fieldCls} w-full`}
            />
          </Stack>
        )}
        <Row gap="sm" justify="end">
          <button autoFocus onClick={onClose} className={textBtn}>
            Cancel
          </button>
          <button
            onClick={() => {
              onClose()
              action(
                optionOn && picked?.option ? `${choice}${WITH_OPTION}` : choice,
                request.reason ? reason.trim() || undefined : undefined
              )
            }}
            className={danger ? filledDangerBtn : filledBtn}
          >
            {confirm}
          </button>
        </Row>
      </Stack>
    </Dialog>
  )
}

export default function ServerSettings() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'server_settings' ? (
    <Settings key={dialog.server} server={dialog.server} section={dialog.section ?? null} />
  ) : null
}

// What members may set in their own profile of the server. For people with Manage server, while
// the site has server profiles on.
function ServerProfilesSetting({ server }: { server: string }) {
  const { api } = useAccount()
  const mode = useStore(s => s.servers[server]?.profiles_mode ?? 'all')
  const on = useStore(s => s.settings.server_profiles !== false)
  if (!on) return null
  return (
    <ProfilesModeField
      mode={mode}
      onChange={next => api.updateServer(server, { profiles_mode: next })}
    />
  )
}

// `section`: the section to open, as the overlay asks; null opens the list on phones and the first
// section on wide screens.
function Settings({ server, section }: { server: string; section: ServerSettingsSection | null }) {
  const acct = useAccount()

  const {
    store,
    lifetime: { inSession },
  } = useAccount()
  const { revokeAdminFor } = store.menu
  const detail = useStore(s => s.servers[server])
  const me = useStore(s => s.me)
  const perms = useStore(s => serverAdminPerms(s, server))
  const cache = useStore(s => s.members[server])
  const loadMembers = useStore(s => s.loadMembers)
  const closeDialog = useStore(s => s.closeDialog)
  const renameServer = useStore(s => s.renameServer)
  const deleteServer = useStore(s => s.deleteServer)
  const askConfirm = useStore(s => s.askConfirm)
  const grantAdmin = useStore(s => s.grantAdmin)
  const openDialog = useStore(s => s.openDialog)
  const [name, setName] = useState(detail?.display_name ?? '')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const canSettings = hasPerm(perms, Perm.ManageServer)
  // Member rows lead with the name the server shows, the username after it.
  const shownOf = useShownMembers(server)
  const canInvites = hasPerm(perms, Perm.ManageInvites)
  const canAssign = hasPerm(perms, Perm.AssignRoles)
  const canAdmin = hasPerm(perms, Perm.ManageAdmins)
  const canSearch = hasBit(perms, MEMBER_SEARCH_PERMS)
  const siteAdmin = me?.is_site_admin ?? false
  const limit = siteAdmin ? undefined : perms
  const promote = canPromote(perms, siteAdmin)
  const found = useMemberSearch(server, q, false, !canSearch)
  const adminList = useMemberSearch(server, q, true, canAdmin)
  const reloadFound = found.reload
  const reloadAdmins = adminList.reload
  const reloadBoth = useCallback(() => {
    reloadFound()
    reloadAdmins()
    void loadMembers(server, true)
  }, [reloadFound, reloadAdmins, loadMembers, server])
  const adminTick = useStore(s => s.adminChanges[server] ?? 0)
  const seenTick = useRef(adminTick)
  useEffect(() => {
    if (adminTick === seenTick.current) return
    seenTick.current = adminTick
    reloadFound()
    reloadAdmins()
  }, [adminTick, reloadFound, reloadAdmins])
  useEffect(() => {
    void loadMembers(server)
  }, [server, loadMembers])
  const more = useCallback(() => void loadMembers(server), [server, loadMembers])
  if (!detail || !me || perms === 0) return null
  const loaded = cache?.list ?? []
  const admins = adminList.list
  const others = (found.active ? found.list : loaded).filter(m => !canAdmin || !m.is_admin)

  const rolesButton = (m: Member) =>
    canAssign && changeableRoles(store.getState(), server, m.username).length > 0 ? (
      <button
        onClick={e =>
          openChoiceMenu(
            e.clientX,
            e.clientY,
            'member_roles',
            {
              kind: 'member',
              user: m,
              server,
              where: 'list',
            },
            {},
            acct
          )
        }
        className={textBtn}
      >
        Roles
      </button>
    ) : null

  const memberRow = (m: Member, action: ReactNode, extra?: ReactNode) => (
    <Surface key={m.username} pad="sm" gap="xs" tone="plain" radius="lg">
      <Row gap="sm">
        <UserAvatar
          username={m.username}
          avatarKind={shownOf(m).avatar_kind}
          avatarColor={shownOf(m).avatar_color}
          size={28}
        />
        <span className="min-w-0 flex-1">
          <span className="streamer block truncate text-sm">
            <NameWithUsername user={shownOf(m)} />
          </span>
          {m.joined_via && (
            <span className="block truncate text-xs text-on-surface-variant">
              Joined with: {passwordName(m.joined_via.label)}
            </span>
          )}
        </span>
        {rolesButton(m)}
        {action}
      </Row>
      {extra}
    </Surface>
  )

  const rename = (
    <>
      <p className={sectionCls}>Rename Server</p>
      <Row
        as="form"
        gap="sm"
        align="stretch"
        onSubmit={e => {
          e.preventDefault()
          const trimmed = name.trim()
          if (!trimmed) return
          setRenameError(null)
          renameServer(server, trimmed).then(closeDialog, (err: unknown) =>
            setRenameError(errorText(err))
          )
        }}
      >
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Server name"
          className={`${fieldCls} streamer`}
        />
        <button className={filledBtn}>Rename</button>
      </Row>
      <FieldError message={renameError} />
    </>
  )

  const body: Record<ServerSettingsSection, () => ReactNode> = {
    invites: () => (
      <>
        {!sharedByCode(detail.join_mode) && (
          <InviteLinkField server={server} hasPassword={detail.has_password} />
        )}
        {(sharedByCode(detail.join_mode) || (canInvites && detail.has_password)) && (
          <StandingInvite key={server} server={server} manage={canInvites} />
        )}
      </>
    ),
    overview: () => (
      <>
        {server !== 'rchat' && (
          <>
            {rename}
            <HostedAbout server={server} />
          </>
        )}
        <ServerAppearance server={server} />
      </>
    ),
    widgets: () => <WidgetSettings server={server} channels={detail.channels} />,
    messages: () => <HostedSystemMessages server={server} />,
    uploads: () => <ServerUploadExpiry server={server} />,
    profiles: () => <ServerProfilesSetting server={server} />,
    access: () =>
      server === 'rchat' ? (
        <GuestParticipation server={server} />
      ) : (
        <ServerAccessSection
          canSettings={canSettings}
          canInvites={canInvites}
          server={server}
          hasPassword={detail.has_password}
          canRemove={hasPerm(perms, Perm.Kick)}
          publicRead={detail.public_read ?? null}
          membersVisible={parseMembersVisible(detail.members_visible)}
        />
      ),
    roles: () => (
      <RolesEditor
        server={server}
        roles={detail.roles}
        version={detail.roles_version}
        limit={limit}
        limits={detail.role_limits}
      />
    ),
    channels: () => (
      <>
        <CategoryCreator server={server} />
        {(detail.categories ?? []).map(cat => (
          <CategoryControls
            key={cat.id}
            server={server}
            category={cat}
            synced={detail.channels.filter(c => c.category_id === cat.id && c.perm_sync).length}
          />
        ))}
        {detail.channels.map(c => (
          <ChannelControls key={c.id} server={server} channel={c} />
        ))}
      </>
    ),
    members: () => (
      <>
        {canAdmin && (
          <>
            <p className={sectionCls}>Admins</p>
            <Stack gap="sm">
              <MemberSearchField
                value={q}
                onChange={setQ}
                placeholder={canSearch ? 'Search admins' : undefined}
              />
              <Stack gap="none">
                {admins.map(m =>
                  memberRow(
                    m,
                    <>
                      <button
                        onClick={() =>
                          setEditingAdmin(editingAdmin === m.username ? null : m.username)
                        }
                        className={textBtn}
                      >
                        Perms
                      </button>
                      <span
                        title={
                          limit !== undefined &&
                          !canRevoke(limit, false, m.perms, rolePerms(m, detail.roles))
                            ? REVOKE_RAISES
                            : undefined
                        }
                      >
                        <button
                          onClick={() => revokeAdminFor(server, m.username, reloadBoth)}
                          disabled={
                            limit !== undefined &&
                            !canRevoke(limit, false, m.perms, rolePerms(m, detail.roles))
                          }
                          className={`${dangerBtn} disabled:pointer-events-none`}
                        >
                          Remove
                        </button>
                      </span>
                    </>,
                    editingAdmin === m.username && (
                      <div className="pl-9">
                        <AdminPermsEditor
                          server={server}
                          username={m.username}
                          perms={m.perms}
                          limit={limit}
                        />
                      </div>
                    )
                  )
                )}
                {adminList.hasMore && (
                  <Sentinel key={`a${admins.length}`} onVisible={adminList.more} />
                )}
              </Stack>
            </Stack>
          </>
        )}
        {canSearch ? (
          <>
            <p className={sectionCls}>Members</p>
            <HostedMembers server={server} roles={detail.roles} perms={perms} />
          </>
        ) : (
          canAdmin && (
            <>
              <p className={sectionCls}>Members</p>
              {others.length ? (
                others.map(m =>
                  memberRow(
                    m,
                    promote && (
                      <button
                        onClick={() =>
                          void grantAdmin(server, m.username).then(inSession(reloadBoth))
                        }
                        className={textBtn}
                      >
                        Make Admin
                      </button>
                    )
                  )
                )
              ) : (
                <Surface pad="sm" inset="bar" tone="plain" radius="none">
                  <p className="text-sm text-on-surface-variant">
                    {found.active
                      ? found.loading
                        ? 'Searching…'
                        : 'No matching members.'
                      : 'Everyone here is an admin.'}
                  </p>
                </Surface>
              )}
              {found.active
                ? found.hasMore && <Sentinel key={`q${found.list.length}`} onVisible={found.more} />
                : (cache?.hasMore ?? false) && <Sentinel key={loaded.length} onVisible={more} />}
            </>
          )
        )}
      </>
    ),
    bans: () => <BanList server={server} />,
    integrations: () => (
      <>
        <Row gap="md" wrap>
          <p className="min-w-48 flex-1 text-xs text-on-surface-variant">
            Webhooks post into channels from scripts and services, or send this server&apos;s events
            to a URL.
          </p>
          <button onClick={() => openDialog({ kind: 'webhooks', server })} className={textBtn}>
            Webhooks
          </button>
        </Row>
      </>
    ),
    audit: () => (
      <>
        <Row gap="md" wrap>
          <p className="min-w-48 flex-1 text-xs text-on-surface-variant">
            See who changed what in this server over the last 90 days.
          </p>
          <button onClick={() => openDialog({ kind: 'audit_log', server })} className={textBtn}>
            Open audit log
          </button>
        </Row>
      </>
    ),
    delete: () => (
      <>
        <Row gap="md" wrap>
          <p className="min-w-48 flex-1 text-xs text-on-surface-variant">
            Deletes the server with all of its channels and messages for everyone. This cannot be
            undone.
          </p>
          <button
            onClick={() =>
              askConfirm({
                title: 'Delete Server',
                body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
                confirm: 'Delete',
                action: () => {
                  closeDialog()
                  void deleteServer(server)
                },
              })
            }
            className="rounded-full border border-error px-4 py-2 text-sm font-medium text-error hover:bg-error-container hover:text-on-error-container"
          >
            Delete server
          </button>
        </Row>
      </>
    ),
  }
  return (
    <PlaceProvider place={HostedServer.open(acct, server)}>
      <ServerSettingsPage
        first={section}
        render={id => (id in body ? body[id as ServerSettingsSection]() : null)}
        actor={<ViewActorTag header />}
      />
    </PlaceProvider>
  )
}
