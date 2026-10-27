'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Hash, Trash2, TriangleAlert, X } from 'lucide-react'
import type { Page } from '../lib/lists'
import { api } from '../lib/instances'
import {
  changeableRoles,
  errorText,
  revokeAdminFor,
  roleMenuItems,
  serverAdminPerms,
  useStore,
  type ConfirmRequest,
} from '../lib/store'
import {
  SLOWMODE_MAX,
  adminMask,
  canGrant,
  canPromote,
  canSetAdminPerms,
  REVOKE_RAISES,
  canRevoke,
  passwordDone,
  passwordPrompt,
  roleDeleteBlock,
  roleEditBlock,
  rolePerms,
} from '../lib/rules'
import { inviteUrl } from '../lib/invite'
import { ALL_PERMS, Perm, hasPerm } from '../lib/types'
import type {
  Channel,
  ChannelPerm,
  ConfirmChoice,
  Member,
  Role,
  RoleLimits,
  ServerDetail,
} from '../lib/types'
import { UserAvatar } from './user_avatar'
import { ColorField } from './color_field'
import { ServerHeader } from './server_header'
import {
  BANNER_PRESETS,
  NAME_PRESETS,
  THEME_ON_SURFACE,
  THEME_SURFACES,
  contrastWarning,
  headerColors,
} from '../lib/server_colors'

export const fieldCls =
  'min-w-0 flex-1 rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm'
export const filledBtn =
  'rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-40'
export const textBtn =
  'rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest'
export const dangerBtn =
  'rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest disabled:opacity-40'
export const sectionCls =
  'pb-2 pt-5 text-xs font-medium uppercase tracking-wide text-on-surface-variant first:pt-0'

export function FieldError({ message, id }: { message: string | null; id?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="pt-1.5 text-xs text-error">
      {message}
    </p>
  )
}

export type EscapeLayer = 'panel' | 'dialog' | 'confirm'

const covered = (layer: EscapeLayer) => {
  const s = useStore.getState()
  if (s.contextMenu) return true
  if (layer === 'confirm') return false
  if (s.confirm) return true
  if (layer === 'dialog') return false
  return (
    s.activeDialog !== null ||
    s.profile !== null ||
    s.invite !== null ||
    document.querySelector('[aria-modal="true"]') !== null
  )
}

export function useEscape(onEscape: () => void, layer: EscapeLayer = 'dialog') {
  const ref = useRef(onEscape)
  useEffect(() => {
    ref.current = onEscape
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !covered(layer)) ref.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer])
}

export function useBackdrop(onClose: () => void) {
  const pressed = useRef(false)
  return {
    onMouseDown: (e: React.MouseEvent) => {
      pressed.current = e.target === e.currentTarget
    },
    onClick: (e: React.MouseEvent) => {
      const hit = pressed.current && e.target === e.currentTarget
      pressed.current = false
      if (hit) onClose()
    },
  }
}

export function Sentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onVisible()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onVisible])
  return <div ref={ref} className="h-px" />
}

const SEARCH_DEBOUNCE = 250
const PICKER_HITS = 8
const PICKER_PAGES = 4

interface MemberSearch {
  list: Member[]
  next: string | null
  loading: boolean
}

export function useMemberSearch(server: string, q: string, admins = false, enabled = true) {
  const needle = q.trim()
  const active = enabled && (needle !== '' || admins)
  const [state, setState] = useState<MemberSearch>({ list: [], next: null, loading: false })
  const [tick, setTick] = useState(0)
  const epoch = useRef(0)
  const setError = useStore(s => s.setError)

  const fetchFrom = useCallback(
    async (cursor: string | null, mine: number) => {
      setState(s => ({ ...s, loading: true }))
      try {
        const page = await api.listMembers(server, cursor, {
          q: needle || undefined,
          admins,
        })
        if (epoch.current !== mine) return
        setState(s => {
          const base = cursor === null ? [] : s.list
          const seen = new Set(base.map(m => m.username))
          return {
            list: [...base, ...page.items.filter(m => !seen.has(m.username))],
            next: page.next,
            loading: false,
          }
        })
      } catch (e) {
        if (epoch.current !== mine) return
        setState(s => ({ ...s, loading: false }))
        setError(errorText(e))
      }
    },
    [server, needle, admins, setError]
  )

  useEffect(() => {
    const mine = ++epoch.current
    if (!active) {
      setState({ list: [], next: null, loading: false })
      return
    }
    const t = setTimeout(() => void fetchFrom(null, mine), needle ? SEARCH_DEBOUNCE : 0)
    return () => clearTimeout(t)
  }, [active, needle, fetchFrom, tick])

  const more = useCallback(() => {
    if (state.loading || state.next === null) return
    void fetchFrom(state.next, epoch.current)
  }, [state, fetchFrom])
  const reload = useCallback(() => setTick(t => t + 1), [])
  return {
    active,
    list: state.list,
    loading: state.loading,
    more,
    hasMore: state.next !== null,
    reload,
  }
}

export function MemberSearchField({
  value,
  onChange,
  placeholder = 'Search members',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="mb-2 flex">
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={fieldCls}
      />
    </div>
  )
}

export function MemberPicker({
  server,
  onPick,
  exclude,
}: {
  server: string
  onPick: (m: Member) => void
  exclude?: (m: Member) => boolean
}) {
  const [q, setQ] = useState('')
  const found = useMemberSearch(server, q)
  const matching = found.list.filter(m => !exclude?.(m))
  const hits = matching.slice(0, PICKER_HITS)
  const pages = useRef({ q: '', count: 0 })
  const { active, loading, hasMore, more } = found
  useEffect(() => {
    if (pages.current.q !== q) pages.current = { q, count: 0 }
    if (!active || loading || !hasMore || matching.length >= PICKER_HITS) return
    if (pages.current.count >= PICKER_PAGES) return
    pages.current.count += 1
    more()
  }, [q, active, loading, hasMore, more, matching.length])
  return (
    <div className="min-w-0 flex-1">
      <input
        type="search"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Add member…"
        title="Search members to add"
        className={`${fieldCls} w-full`}
      />
      {found.active && (
        <div className="mt-1 space-y-0.5">
          {hits.map(m => (
            <button
              key={m.username}
              onClick={() => {
                onPick(m)
                setQ('')
              }}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-surface-container-highest"
            >
              <UserAvatar
                username={m.username}
                avatarKind={m.avatar_kind}
                avatarColor={m.avatar_color}
                size={20}
              />
              <span className="streamer min-w-0 flex-1 truncate text-sm">{m.display_name}</span>
            </button>
          ))}
          {!found.loading && hits.length === 0 && (
            <p className="px-2 py-1 text-xs text-on-surface-variant">
              {found.hasMore ? 'Keep typing to narrow the search.' : 'No matching members.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function Dialog({
  title,
  onClose,
  children,
  full = false,
  layer = 'dialog',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  full?: boolean
  layer?: EscapeLayer
}) {
  const titleId = useId()
  const backdrop = useBackdrop(onClose)
  useEscape(onClose, layer)
  return (
    <div
      className={`fixed inset-x-0 top-0 ${layer === 'confirm' ? 'z-50' : 'z-40'} flex h-app items-center justify-center bg-scrim/60 ${full ? 'px-safe sm:px-safe-4 sm:py-4' : 'px-safe-4 py-4'}`}
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full overflow-y-auto bg-surface-container-high p-6 shadow-elevation-3 ${
          full
            ? 'h-full max-h-none sm:h-auto sm:max-h-[min(85vh,100%)] sm:max-w-lg sm:rounded-2xl'
            : 'max-h-[min(85vh,100%)] max-w-lg rounded-2xl'
        }`}
      >
        <div
          className={`flex items-center justify-between ${
            full
              ? 'sticky -top-6 z-10 -mx-6 -mt-6 mb-4 bg-surface-container-high px-6 py-4'
              : 'mb-4'
          }`}
        >
          <h2 id={titleId} className="text-lg font-medium text-on-surface">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const PERM_ITEMS: { label: string; bit: number }[] = [
  { label: 'Manage channels', bit: Perm.ManageChannels },
  { label: 'Delete messages', bit: Perm.DeleteMessages },
  { label: 'Kick', bit: Perm.Kick },
  { label: 'Delete server', bit: Perm.DeleteServer },
  { label: 'Manage admins', bit: Perm.ManageAdmins },
]

const GRANT_NOTE = 'You can only give permissions you have.'

function PermChecks({
  value,
  onChange,
  allowed,
  locked,
}: {
  value: number
  onChange: (v: number) => void
  allowed?: (v: number) => boolean
  locked?: string | null
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {PERM_ITEMS.map(({ label, bit }) => {
        const off = !!locked || (allowed !== undefined && !allowed(value ^ bit))
        return (
          <label
            key={bit}
            title={off ? (locked ?? GRANT_NOTE) : undefined}
            className={`flex items-center gap-1.5 text-sm ${off ? 'opacity-60' : ''}`}
          >
            <input
              type="checkbox"
              checked={hasPerm(value, bit)}
              disabled={off}
              onChange={() => onChange(value ^ bit)}
              className="accent-primary"
            />
            {label}
          </label>
        )
      })}
    </div>
  )
}

function LockedNote() {
  return (
    <p className="pt-1.5 text-xs text-on-surface-variant">
      This admin has permissions you don&apos;t have. You can take permissions away, but you can
      only give permissions you have.
    </p>
  )
}

function ColorSwatch({
  initial,
  onCommit,
  locked,
}: {
  initial: string
  onCommit: (color: string) => void
  locked?: string | null
}) {
  const [color, setColor] = useState(initial)
  useEffect(() => setColor(initial), [initial])
  return (
    <input
      type="color"
      value={color}
      title={locked ?? 'Role color'}
      disabled={!!locked}
      onChange={e => setColor(e.target.value)}
      onBlur={() => {
        if (color !== initial) onCommit(color)
      }}
      className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-60"
    />
  )
}

function RoleRow({
  server,
  role,
  refresh,
  limit,
  limits,
}: {
  server: string
  role: Role
  refresh?: () => void
  limit?: number
  limits?: RoleLimits
}) {
  const updateRole = useStore(s => s.updateRole)
  const deleteRole = useStore(s => s.deleteRole)
  const [name, setName] = useState(role.name)
  useEffect(() => setName(role.name), [role.name])
  const after = () => refresh?.()
  const locked = limit === undefined ? null : roleEditBlock(limit, false, role, limits)
  const noDelete = limit === undefined ? null : roleDeleteBlock(limit, false, role, limits)
  return (
    <div className="space-y-1.5 rounded-xl bg-surface-container p-2">
      <div className="flex items-center gap-2">
        <ColorSwatch
          initial={role.color}
          locked={locked}
          onCommit={color => void updateRole(server, role.id, { color }).then(after)}
        />
        <form
          onSubmit={e => {
            e.preventDefault()
            const trimmed = name.trim()
            if (!locked && trimmed && trimmed !== role.name)
              void updateRole(server, role.id, { name: trimmed }).then(after)
          }}
          title={locked ?? undefined}
          className="flex min-w-0 flex-1 gap-2"
        >
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Role name"
            disabled={!!locked}
            className={`${fieldCls} disabled:opacity-60`}
          />
          <button
            disabled={!!locked}
            className={`${textBtn} disabled:opacity-60 disabled:hover:bg-transparent`}
          >
            Rename
          </button>
        </form>
        <span title={noDelete ?? `Delete ${role.name}`} className="shrink-0">
          <button
            onClick={() => void deleteRole(server, role.id).then(after)}
            disabled={!!noDelete}
            aria-label={`Delete ${role.name}`}
            title={noDelete ?? `Delete ${role.name}`}
            className={`${dangerBtn} disabled:pointer-events-none`}
          >
            <Trash2 size={16} />
          </button>
        </span>
      </div>
      <PermChecks
        value={role.perms}
        locked={locked}
        allowed={limit === undefined ? undefined : v => canGrant(limit, false, v)}
        onChange={v => void updateRole(server, role.id, { perms: v }).then(after)}
      />
      {(locked ?? noDelete) && (
        <p className="pt-1.5 text-xs text-on-surface-variant">{locked ?? noDelete}</p>
      )}
    </div>
  )
}

export function RolesEditor({
  server,
  roles,
  refresh,
  limit,
  limits,
}: {
  server: string
  roles: Role[]
  refresh?: () => void
  limit?: number
  limits?: RoleLimits
}) {
  return (
    <div className="space-y-2">
      {roles.map(r => (
        <RoleRow
          key={r.id}
          server={server}
          role={r}
          refresh={refresh}
          limit={limit}
          limits={limits}
        />
      ))}
      <RoleCreate server={server} refresh={refresh} />
    </div>
  )
}

function RoleCreate({ server, refresh }: { server: string; refresh?: () => void }) {
  const createRole = useStore(s => s.createRole)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#7c4dff')
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        void createRole(server, { name: trimmed, color, perms: 0 }).then(() => {
          setName('')
          refresh?.()
        })
      }}
      className="flex items-center gap-2"
    >
      <input
        type="color"
        value={color}
        title="Role color"
        onChange={e => setColor(e.target.value)}
        className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5"
      />
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="New role"
        className={fieldCls}
      />
      <button className={textBtn}>Add</button>
    </form>
  )
}

export function ChannelPermsEditor({
  channelId,
  server,
  roles,
}: {
  channelId: number
  server: string
  roles: Role[]
}) {
  const setChannelPerm = useStore(s => s.setChannelPerm)
  const clearChannelPerm = useStore(s => s.clearChannelPerm)
  const setError = useStore(s => s.setError)
  const [rows, setRows] = useState<ChannelPerm[]>([])
  const [subject, setSubject] = useState('')

  const reload = useCallback(async () => {
    try {
      const all: ChannelPerm[] = []
      let cursor: string | null = null
      do {
        const page: Page<ChannelPerm> = await api.channelPerms(channelId, cursor)
        all.push(...page.items)
        cursor = page.next
      } while (cursor !== null)
      setRows(all)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [channelId, setError])
  useEffect(() => {
    void reload()
  }, [reload])

  const save = (perm: ChannelPerm) => void setChannelPerm(channelId, perm).then(reload)
  const label = (subj: string) =>
    subj.startsWith('u:') ? subj.slice(2) : (roles.find(r => `r:${r.id}` === subj)?.name ?? subj)
  const flag = (
    perm: ChannelPerm,
    key: 'can_view' | 'can_send' | 'can_read_history',
    text: string
  ) => (
    <label className="flex items-center gap-1 text-xs">
      <input
        type="checkbox"
        checked={perm[key]}
        onChange={() => save({ ...perm, [key]: !perm[key] })}
        className="accent-primary"
      />
      {text}
    </label>
  )

  return (
    <div className="mt-1.5 space-y-1.5 rounded-xl bg-surface-container-low p-2">
      {rows.length === 0 && (
        <p className="text-xs text-on-surface-variant">
          No overrides. The channel is visible to everyone.
        </p>
      )}
      {rows.map(perm => (
        <div key={perm.subject} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="streamer min-w-0 flex-1 truncate text-sm">{label(perm.subject)}</span>
          {flag(perm, 'can_view', 'View')}
          {flag(perm, 'can_send', 'Send')}
          {flag(perm, 'can_read_history', 'History')}
          <button
            onClick={() => void clearChannelPerm(channelId, perm.subject).then(reload)}
            aria-label={`Clear ${label(perm.subject)}`}
            title="Clear override"
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest hover:text-error"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {roles.length > 0 && (
        <div className="flex gap-2">
          <select
            value={subject}
            onChange={e => setSubject(e.target.value)}
            title="Add role"
            className={fieldCls}
          >
            <option value="">Add role…</option>
            {roles.map(r => (
              <option key={r.id} value={`r:${r.id}`}>
                {r.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (!subject || rows.some(r => r.subject === subject)) return
              save({ subject, can_view: true, can_send: true, can_read_history: true })
              setSubject('')
            }}
            className={textBtn}
          >
            Add
          </button>
        </div>
      )}
      <MemberPicker
        server={server}
        exclude={m => rows.some(r => r.subject === `u:${m.username}`)}
        onPick={m =>
          save({
            subject: `u:${m.username}`,
            can_view: true,
            can_send: true,
            can_read_history: true,
          })
        }
      />
    </div>
  )
}

export function ChannelControls({
  server,
  channel,
  roles,
  refresh,
  lead,
}: {
  server: string
  channel: Channel
  roles: Role[]
  refresh?: () => void
  lead?: ReactNode
}) {
  const setSlowmode = useStore(s => s.setSlowmode)
  const [slow, setSlow] = useState(String(channel.slowmode_seconds))
  const [open, setOpen] = useState(false)
  useEffect(() => setSlow(String(channel.slowmode_seconds)), [channel.slowmode_seconds])
  return (
    <div className="rounded-xl px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {lead ?? (
          <span className="flex min-w-0 flex-1 basis-full items-center gap-1.5 text-sm sm:basis-0">
            <Hash size={14} className="shrink-0 text-on-surface-variant" />
            <span className="truncate">{channel.name}</span>
          </span>
        )}
        {channel.kind === 'text' && (
          <form
            onSubmit={e => {
              e.preventDefault()
              const n = Number(slow)
              if (Number.isInteger(n) && n !== channel.slowmode_seconds)
                void setSlowmode(channel.id, n).then(() => refresh?.())
            }}
            className="flex items-center gap-1.5"
          >
            <label
              title={`0 to ${SLOWMODE_MAX} seconds`}
              className="flex items-center gap-1.5 text-xs text-on-surface-variant"
            >
              Slow mode (s)
              <input
                value={slow}
                onChange={e => setSlow(e.target.value)}
                inputMode="numeric"
                className="w-16 rounded-lg border border-outline bg-transparent px-2 py-1 text-base text-on-surface outline-none focus:border-primary md:text-sm"
              />
            </label>
            <button className={textBtn}>Set</button>
          </form>
        )}
        <button onClick={() => setOpen(!open)} className={textBtn}>
          {open ? 'Hide perms' : 'Perms'}
        </button>
      </div>
      {open && <ChannelPermsEditor channelId={channel.id} server={server} roles={roles} />}
    </div>
  )
}

export interface OptionChoice extends ConfirmChoice {
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
  refresh,
}: {
  server: string
  hasPassword: boolean
  canRemove: boolean
  refresh?: () => void
}) {
  const askConfirm = useStore(s => s.askConfirm)
  const siteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  return (
    <>
      <p className={sectionCls}>Password</p>
      <form
        onSubmit={e => {
          e.preventDefault()
          const next = password.trim()
          setError(null)
          setDone(null)
          const prompt = passwordPrompt(hasPassword, next, canRemove, siteAdmin)
          const changed = hasPassword && next !== ''
          askConfirm({
            ...prompt,
            choices: keepGuestsChoices(prompt.choices, changed),
            action: choice => {
              const members = choice.startsWith('remove') ? 'remove' : 'keep'
              const keepGuests = choice === `keep${WITH_OPTION}`
              api.updateServer(server, { password: next, members, keep_guests: keepGuests }).then(
                res => {
                  setPassword('')
                  const guests =
                    changed && members === 'keep'
                      ? keepGuests
                        ? ' Guests kept access.'
                        : ' Guests lost access.'
                      : ''
                  setDone(passwordDone(prompt.confirm, members, res.removed, res.kept) + guests)
                  refresh?.()
                },
                (err: unknown) => setError(errorText(err))
              )
            },
          })
        }}
        className="flex gap-2"
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
      </form>
      <FieldError message={error} />
      {done && (
        <p role="status" className="pt-1.5 text-xs text-on-surface">
          {done}
        </p>
      )}
      <p className="pt-1.5 text-xs text-on-surface-variant">
        {hasPassword
          ? 'Joining requires the password; guests cannot view this server.'
          : 'Anyone can join with the server name.'}
      </p>
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
      <div className="flex flex-col gap-4">
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
          <div className="flex flex-col gap-0.5 px-2 py-2" aria-hidden>
            {preview.map(c => (
              <span
                key={c.id}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-on-surface-variant"
              >
                <Hash size={16} className="shrink-0" />
                <span className="truncate">{c.name}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
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
        </div>
        {!rchat && (
          <div className="flex flex-col gap-1.5">
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
          </div>
        )}
        {warning && (
          <p role="status" className="flex items-start gap-1.5 text-xs text-error">
            <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
            {warning}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
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
                  () => {
                    setDone(true)
                    refresh?.()
                  },
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
        </div>
        <FieldError message={error} />
      </div>
    </>
  )
}

export function InviteLinkField({ server, hasPassword }: { server: string; hasPassword: boolean }) {
  const [password, setPassword] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const link = inviteUrl(server, hasPassword ? password : null)
  const withPassword = hasPassword && password.trim() !== ''
  return (
    <>
      <p className={sectionCls}>Invite</p>
      <div className="flex gap-2">
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
      </div>
      <FieldError message={error} />
      {hasPassword && (
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Server password (optional)"
          autoComplete="off"
          aria-label="Include the server password in the link"
          className={`${fieldCls} mt-2 w-full`}
        />
      )}
      <p className="pt-1.5 text-xs text-on-surface-variant">
        {withPassword
          ? 'Anyone with this link joins without typing the password.'
          : hasPassword
            ? 'People with this link are asked for the password. Type it above to include it in the link.'
            : 'Paste this link in a chat to show an invite card.'}
      </p>
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
  const setAdminPerms = useStore(s => s.setAdminPerms)
  const [lastBlocked, setLastBlocked] = useState(false)
  const value = adminMask(perms)
  return (
    <>
      <PermChecks
        value={value}
        allowed={
          limit === undefined ? undefined : v => v === 0 || canSetAdminPerms(limit, false, perms, v)
        }
        onChange={v => {
          setLastBlocked(v === 0)
          if (v !== 0)
            void setAdminPerms(server, username, v === ALL_PERMS ? 0 : v).then(() => refresh?.())
        }}
      />
      {lastBlocked && (
        <p className="pt-1.5 text-xs text-on-surface-variant">
          An admin keeps at least one permission. To take every permission away, remove them as
          admin instead.
        </p>
      )}
      {limit !== undefined && !canGrant(limit, false, value) && <LockedNote />}
    </>
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
    <div className="space-y-1">
      {list.map(b => (
        <div key={b.username} className="flex items-center gap-2 rounded-xl px-2 py-1.5">
          <UserAvatar
            username={b.username}
            avatarKind={b.avatar_kind}
            avatarColor={b.avatar_color}
            size={28}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="streamer">{b.display_name}</span>
            <span className="text-xs text-on-surface-variant">
              {' '}
              · banned {new Date(b.banned_at * 1000).toLocaleDateString()}
            </span>
          </span>
          <button onClick={() => void unbanMember(server, b.username)} className={textBtn}>
            Unban
          </button>
        </div>
      ))}
      {cache && !cache.loading && list.length === 0 && (
        <p className="px-2 text-sm text-on-surface-variant">No one is banned.</p>
      )}
      {(cache?.hasMore ?? false) && <Sentinel key={list.length} onVisible={more} />}
    </div>
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
  const [optionOn, setOptionOn] = useState(false)
  const picked: OptionChoice | undefined = choices?.find(c => c.value === choice)
  const danger = picked?.danger ?? true
  return (
    <Dialog title={title} onClose={onClose} layer="confirm">
      <p className="text-sm text-on-surface-variant">{body}</p>
      {choices && (
        <fieldset className="mt-4 space-y-2">
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
              <label className="flex cursor-pointer gap-3 px-3 py-2.5">
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
                  <span className="block pt-0.5 text-xs text-on-surface-variant">{c.detail}</span>
                </span>
              </label>
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
        </fieldset>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button autoFocus onClick={onClose} className={textBtn}>
          Cancel
        </button>
        <button
          onClick={() => {
            onClose()
            action(optionOn && picked?.option ? `${choice}${WITH_OPTION}` : choice)
          }}
          className={
            danger
              ? 'rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error hover:opacity-90'
              : filledBtn
          }
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  )
}

export default function ServerSettings() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'server_settings' ? <Settings server={dialog.server} /> : null
}

function Settings({ server }: { server: string }) {
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
  const openContextMenu = useStore(s => s.openContextMenu)
  const [name, setName] = useState(detail?.display_name ?? '')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const canAdmin = hasPerm(perms, Perm.ManageAdmins)
  const siteAdmin = me?.is_site_admin ?? false
  const limit = siteAdmin ? undefined : perms
  const promote = canPromote(perms, siteAdmin)
  const found = useMemberSearch(server, q)
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
  const others = (found.active ? found.list : loaded).filter(m => !m.is_admin)

  const rolesButton = (m: Member) =>
    hasPerm(perms, Perm.ManageAdmins) &&
    changeableRoles(useStore.getState(), server, m.username).length > 0 ? (
      <button
        onClick={e => openContextMenu(e.clientX, e.clientY, roleMenuItems(server, m.username))}
        className={textBtn}
      >
        Roles
      </button>
    ) : null

  const memberRow = (m: Member, action: ReactNode, extra?: ReactNode) => (
    <div key={m.username} className="rounded-xl px-2 py-1.5">
      <div className="flex items-center gap-2">
        <UserAvatar
          username={m.username}
          avatarKind={m.avatar_kind}
          avatarColor={m.avatar_color}
          size={28}
        />
        <span className="streamer min-w-0 flex-1 truncate text-sm">{m.display_name}</span>
        {rolesButton(m)}
        {action}
      </div>
      {extra}
    </div>
  )

  return (
    <Dialog full title="Server Settings" onClose={closeDialog}>
      <InviteLinkField server={server} hasPassword={detail.has_password} />
      {server !== 'rchat' && hasPerm(perms, Perm.DeleteServer) && (
        <>
          <p className={sectionCls}>Rename Server</p>
          <form
            onSubmit={e => {
              e.preventDefault()
              const trimmed = name.trim()
              if (!trimmed) return
              setRenameError(null)
              renameServer(server, trimmed).then(closeDialog, (err: unknown) =>
                setRenameError(errorText(err))
              )
            }}
            className="flex gap-2"
          >
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Server name"
              className={`${fieldCls} streamer`}
            />
            <button className={filledBtn}>Rename</button>
          </form>
          <FieldError message={renameError} />
          <ServerAppearance server={server} />
          <ServerPasswordField
            server={server}
            hasPassword={detail.has_password}
            canRemove={hasPerm(perms, Perm.Kick)}
          />
          <p className={sectionCls}>Delete Server</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
          </div>
        </>
      )}
      {server === 'rchat' && hasPerm(perms, Perm.DeleteServer) && (
        <ServerAppearance server={server} />
      )}
      {hasPerm(perms, Perm.ManageAdmins) && (
        <>
          <p className={sectionCls}>Roles</p>
          <RolesEditor
            server={server}
            roles={detail.roles}
            limit={limit}
            limits={detail.role_limits}
          />
        </>
      )}
      {hasPerm(perms, Perm.ManageChannels) && (
        <>
          <p className={sectionCls}>Channels</p>
          {detail.channels.map(c => (
            <ChannelControls key={c.id} server={server} channel={c} roles={detail.roles} />
          ))}
        </>
      )}
      {hasPerm(perms, Perm.Kick) && (
        <>
          <p className={sectionCls}>Bans</p>
          <BanList server={server} />
        </>
      )}
      {hasPerm(perms, Perm.ManageAdmins) && (
        <>
          <p className={sectionCls}>Admins</p>
          <MemberSearchField value={q} onChange={setQ} />
          {admins.map(m =>
            memberRow(
              m,
              <>
                <button
                  onClick={() => setEditingAdmin(editingAdmin === m.username ? null : m.username)}
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
                <div className="mt-1.5 pl-9">
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
          {adminList.hasMore && <Sentinel key={`a${admins.length}`} onVisible={adminList.more} />}
          <p className={sectionCls}>Members</p>
          {others.length ? (
            others.map(m =>
              memberRow(
                m,
                promote && (
                  <button
                    onClick={() => void grantAdmin(server, m.username).then(reloadBoth)}
                    className={textBtn}
                  >
                    Make Admin
                  </button>
                )
              )
            )
          ) : (
            <p className="px-2 text-sm text-on-surface-variant">
              {found.active
                ? found.loading
                  ? 'Searching…'
                  : 'No matching members.'
                : 'Everyone here is an admin.'}
            </p>
          )}
        </>
      )}
      {found.active
        ? found.hasMore && <Sentinel key={`q${found.list.length}`} onVisible={found.more} />
        : (cache?.hasMore ?? false) && <Sentinel key={loaded.length} onVisible={more} />}
    </Dialog>
  )
}
