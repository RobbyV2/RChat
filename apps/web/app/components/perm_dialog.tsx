'use client'

import { ask, sendTo } from '../lib/asks'
import { Button } from './controls'
import { Name } from './name'
import { personCalled } from '../lib/names'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAccount } from '../lib/client/react'
import { errorText, memberState, myPerms, myRank, orderWith, useMask, useStore } from '../lib/store'
import type { Page } from '../lib/lists'
import { useShallow } from 'zustand/react/shallow'
import { channelMask } from '../lib/selectors'
import { unruledMask } from '../lib/channel_perms'
import { HOSTED, baseBits } from '../lib/perms'
import { type RuleRow, type RuleSource } from '../lib/perm_source'
import {
  EVERYONE_SUBJECT,
  ROLE_DENY_HINT,
  canModerate,
  memberPerms,
  roleDenyEscapes,
  roleEditBlock,
  ruleRow,
} from '../lib/rules'
import { Perm, hasPerm, type Category, type Channel, type ChannelPerm } from '../lib/types'
import { RuleEditor } from './rule_editor'
import { RestrictionToggles } from './settings_fields'
import { MemberPicker } from './member_search'
import { usePermissionRules } from './use_permission_rules'
import { Row, Surface } from './layout'
import { Dialog } from './ui'
import { ViewActorTag } from './view_actor'
import { staffChange, staffViewChannel } from '../lib/staff_view'
import { newestReads } from '../lib/newest_read'
import { Lock } from 'lucide-react'
import { useShownMembers } from './shown_user'

// The rules of a hosted channel or category in the shared rule editor, inline in server settings
// or as a dialog from the channel and category menus.

type Target = { channel: Channel } | { category: Category }

const idOf = (t: Target) => ('channel' in t ? t.channel.id : t.category.id)

function useHostedRows(target: Target, reloadKey: unknown) {
  const account = useAccount()
  const {
    lifetime: { inSession },
  } = account
  const setError = useStore(s => s.setError)
  const askStaffView = useStore(s => s.askStaffView)
  const [rows, setRows] = useState<ChannelPerm[] | null>(null)
  const [shut, setShut] = useState(false)
  const [reads] = useState(newestReads)
  const channel = 'channel' in target
  const id = idOf(target)
  const staffOpen = useStore(s => channel && s.staffOpen.includes(id))
  const reload = useCallback(
    () =>
      reads.read(async live => {
        const showError = inSession(setError)
        const askStaff = inSession(askStaffView)
        try {
          const all: ChannelPerm[] = []
          let cursor: string | null = null
          do {
            const page: Page<ChannelPerm> = channel
              ? await sendTo(account, ask.channelPerms(id, cursor))
              : await sendTo(account, ask.categoryPerms(id, cursor))
            all.push(...page.items)
            cursor = page.next
          } while (cursor !== null)
          if (!live()) return
          setRows(all)
          setShut(false)
        } catch (e) {
          if (!live()) return
          const staff = channel ? staffViewChannel(e) : null
          if (staff === null) {
            showError(errorText(e))
            return
          }
          setRows([])
          setShut(true)
          askStaff(staff)
        }
      }),
    [reads, channel, id, setError, askStaffView]
  )
  useEffect(() => {
    void reload()
  }, [reload, reloadKey])
  // A channel only staff powers open: read again once it is open, shut again when it closes.
  const opened = useRef(staffOpen)
  useEffect(() => {
    const change = staffChange(opened.current, staffOpen)
    opened.current = staffOpen
    if (change === 'read') void reload()
    if (change === 'close') {
      reads.drop()
      setRows([])
      setShut(true)
    }
  }, [staffOpen, reload, reads])
  return { rows, reload, shut }
}

export function HostedRules({
  server,
  target,
  refresh,
}: {
  server: string
  target: Target
  refresh?: () => void
}) {
  const acct = useAccount()
  const {
    lifetime: { inSession },
  } = acct
  const ready = usePermissionRules()
  const detail = useStore(s => s.servers[server])
  const live = useStore(s =>
    'channel' in target ? s.servers[server]?.channels.find(c => c.id === target.channel.id) : null
  )
  const channel = 'channel' in target ? (live ?? target.channel) : null
  const { rows, reload, shut } = useHostedRows(target, live ?? detail)
  const askStaffView = useStore(st => st.askStaffView)
  useStore(useShallow(st => [st.me, st.servers[server], st.members[server], st.memberInfo[server]]))
  const s = acct.store.getState()
  const setChannelPerm = useStore(st => st.setChannelPerm)
  const clearChannelPerm = useStore(st => st.clearChannelPerm)
  const setCategoryPerm = useStore(st => st.setCategoryPerm)
  const clearCategoryPerm = useStore(st => st.clearCategoryPerm)
  const setChannelRestrict = useStore(st => st.setChannelRestrict)
  const syncChannelPerms = useStore(st => st.syncChannelPerms)
  const ensureMembers = useStore(st => st.ensureMembers)
  const streamer = useStore(st => st.streamer)
  const shownOf = useShownMembers(server)
  const mask = useMask()
  const id = idOf(target)
  const members = useMemo(
    () => (rows ?? []).filter(r => r.subject.startsWith('u:')).map(r => r.subject.slice(2)),
    [rows]
  )
  useEffect(() => {
    if (members.length) void ensureMembers(server, members)
  }, [server, members, ensureMembers])
  if (shut && channel)
    return (
      <Surface pad="sm" tone="low" radius="lg">
        <Row gap="sm" wrap>
          <Lock size={14} className="shrink-0 text-on-surface-variant" />
          <span className="min-w-0 flex-1 text-xs text-on-surface-variant">
            Confirm to open this channel
          </span>
          <Button onClick={() => askStaffView(channel.id)}>Open channel</Button>
        </Row>
      </Surface>
    )
  if (!ready || !detail || !rows) return null
  const roles = detail.roles
  const me = s.me
  const perms = myPerms(s, server)
  const siteAdmin = me?.is_site_admin ?? false
  const mine = me ? memberState(s, server, me.username) : null
  const exempt = siteAdmin || (mine?.is_admin === true && mine.perms === 0)
  const confirmed = detail.roles_order_confirmed === true
  const rank = myRank(s, server)
  const roleOf = (subject: string) => roles.find(r => `r:${r.id}` === subject)
  const subjectOk = (subject: string) => {
    if (subject === EVERYONE_SUBJECT) return true
    const role = roleOf(subject)
    if (role)
      return (
        hasPerm(perms, Perm.ManageRoles) &&
        roleEditBlock(perms, siteAdmin, role, detail.role_limits, rank, confirmed) === null
      )
    const name = subject.slice(2)
    const them = memberState(s, server, name)
    if (!them) return true
    return canModerate(perms, siteAdmin, memberPerms(them, roles), orderWith(s, server, name))
  }
  const done = () => inSession(reload)()
  const synced = detail.channels.filter(
    c => 'category' in target && c.category_id === target.category.id && c.perm_sync
  )
  const src: RuleSource = {
    ruleset: HOSTED,
    place: channel ? (channel.kind === 'voice' ? 'voice' : 'text') : 'category',
    everyone: EVERYONE_SUBJECT,
    rows: rows.map((r): RuleRow => ({ subject: r.subject, ...ruleRow(r) })),
    canonical: bits => bits,
    mine: channel
      ? channelMask(s, server, channel.id)
      : unruledMask({}, false, detail.my_perms ?? perms),
    also: synced.map(c => channelMask(s, server, c.id)),
    exempt,
    subjectOk,
    lock: () => null,
    merges: true,
    write: (subject, rule, merge) => {
      const body = { subject, ...rule, mode: merge ? ('merge' as const) : ('override' as const) }
      return (channel ? setChannelPerm(id, body) : setCategoryPerm(id, body)).then(done)
    },
    clear: subject =>
      (channel ? clearChannelPerm(id, subject) : clearCategoryPerm(id, subject)).then(done),
    everyoneBits: detail.everyone_perms ?? baseBits(),
    roleBits: Object.fromEntries(roles.map(r => [`r:${r.id}`, r.perms])),
    memberRoles: subject =>
      (memberState(s, server, subject.slice(2))?.role_ids ?? []).map(r => `r:${r}`),
    memberWho: subject => {
      const m = memberState(s, server, subject.slice(2))
      if (!m?.is_admin) return undefined
      return m.perms === 0
        ? { kind: 'owner' }
        : { kind: 'admin', mask: m.perms, roles: memberPerms({ ...m, is_admin: false }, roles) }
    },
    restrictView: channel?.restrict_view === true,
    restrictSend: channel?.restrict_send === true,
  }
  const nameOf = (subject: string) => {
    const m = memberState(s, server, subject.slice(2))
    return m ? shownOf(m).display_name : subject.slice(2)
  }
  const label = (subject: string) =>
    subject === EVERYONE_SUBJECT
      ? '@everyone'
      : subject.startsWith('r:')
        ? (roleOf(subject)?.name ?? 'Deleted role')
        : streamer
          ? 'this member'
          : subject === `u:${me?.username}`
            ? nameOf(subject)
            : mask(nameOf(subject))
  const render = (subject: string): ReactNode => {
    const role = roleOf(subject)
    return (
      <>
        {role && (
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: role.color || 'var(--color-outline)' }}
          />
        )}
        {subject.startsWith('u:') ? (
          <Name of={personCalled(nameOf(subject), subject.slice(2))} look="truncate" />
        ) : (
          <span className={`truncate ${role ? 'streamer' : ''}`}>{label(subject)}</span>
        )}
      </>
    )
  }
  const listed = (subject: string) => rows.some(r => r.subject === subject)
  const category = channel && detail.categories?.find(c => c.id === channel.category_id)
  return (
    <RuleEditor
      src={src}
      label={label}
      render={render}
      roleOrder={roles.map(r => `r:${r.id}`)}
      addable={[
        { subject: EVERYONE_SUBJECT, label: '@everyone' },
        ...roles.map(r => ({ subject: `r:${r.id}`, label: r.name })),
      ]}
      memberPicker={pick => (
        <MemberPicker
          server={server}
          exclude={m => listed(`u:${m.username}`)}
          onPick={m => pick(`u:${m.username}`)}
        />
      )}
      empty={channel ? undefined : 'No rules yet. Rules here reach the channels synced with it.'}
    >
      {channel ? (
        <>
          {category && (
            <Row data-sync gap="sm" wrap>
              <span className="min-w-0 flex-1 text-xs text-on-surface-variant">
                {channel.perm_sync
                  ? `Synced with ${category.name}. Changing a rule here stops it.`
                  : `Not synced with ${category.name}.`}
              </span>
              {!channel.perm_sync && (
                <Button
                  type="button"
                  onClick={() =>
                    void syncChannelPerms(server, channel.id).then(
                      inSession(() => {
                        void reload()
                        refresh?.()
                      })
                    )
                  }
                >
                  Sync now
                </Button>
              )}
            </Row>
          )}
          <RestrictionToggles
            nobody="admins"
            value={channel}
            send={channel.kind === 'text'}
            onToggle={key =>
              void setChannelRestrict(channel.id, { [key]: !channel[key] }).then(
                inSession(() => refresh?.())
              )
            }
          />
          {roleDenyEscapes(channel, rows, detail.everyone_perms) && (
            <p className="text-xs text-on-surface-variant">{ROLE_DENY_HINT}</p>
          )}
        </>
      ) : (
        <p data-copies className="text-xs text-on-surface-variant">
          {synced.length === 1
            ? 'Applies to 1 synced channel.'
            : `Applies to ${synced.length} synced channels.`}
        </p>
      )}
    </RuleEditor>
  )
}

export default function PermsDialog() {
  const dialog = useStore(s => (s.activeDialog?.kind === 'perms' ? s.activeDialog : null))
  const closeDialog = useStore(s => s.closeDialog)
  const detail = useStore(s => (dialog ? s.servers[dialog.server] : undefined))
  if (!dialog || !detail) return null
  const channel =
    dialog.channel !== undefined ? detail.channels.find(c => c.id === dialog.channel) : undefined
  const category =
    dialog.category !== undefined
      ? detail.categories?.find(c => c.id === dialog.category)
      : undefined
  const target: Target | null = channel ? { channel } : category ? { category } : null
  if (!target) return null
  const title = channel
    ? `${channel.kind === 'voice' ? channel.name : `#${channel.name}`} permissions`
    : `${category!.name} permissions`
  return (
    <Dialog actor={<ViewActorTag header />} full title={title} onClose={closeDialog}>
      <HostedRules
        key={channel ? `c${channel.id}` : `k${category!.id}`}
        server={dialog.server}
        target={target}
      />
    </Dialog>
  )
}
