'use client'

import { Name, NameSelect } from './name'
import { accountLabel, handleName, instanceAddress, instanceName, personCalled } from '../lib/names'
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  GripVertical,
  MoreHorizontal,
  Plus,
  Settings,
  X,
} from 'lucide-react'
import { client } from '../lib/client/client'
import { accountStorage } from '../lib/client/keys'
import { savedConnection } from '../lib/client/saved_session'
import { readLocal } from '../lib/instances'
import { useAccount } from '../lib/client/react'
import {
  createSwitcherSource,
  moveSwitcherRow,
  type OrderTarget,
  signOutSwitcherAccount,
  type SwitcherRow,
} from '../lib/client/switcher_rows'
import { switchActor, switcherSession } from '../lib/client/switch_actor'
import { setConnected, setIdentityBackground } from '../lib/client/book'
import { IdentityEnrollment } from './p2p/identity_enrollment'
import { confirmIdentityRemoval } from '../lib/client/identity_enrollment'
import { useMask, useStore } from '../lib/store'
import type { SettingsSection } from '../lib/settings_sections'
import { AccountTag, ActorAvatar, InstanceTag } from './account_tag'
import { hostedLockMessage } from '../lib/client/hosted_policy'
import { useAddingAllowed } from './add_instance'
import { longPress, useMedia } from './context_menu'
import { RailInstance } from './instance_badge'
import { Button, IconButton, ListRow, CardButton } from './controls'
import { Row, Stack, Surface, Inset } from './layout'
import { Sheet, useEscape, smallFieldCls } from './ui'
import { obj, opt, parseJson, str, type Schema } from '../lib/schema'

function useRows() {
  const [source] = useState(createSwitcherSource)
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
const NARROW = '(max-width: 767px)'
const keyOf = (row: SwitcherRow) => JSON.stringify([row.origin, row.username, row.local])

export function AccountSwitcherTile() {
  const account = useAccount()
  const model = useRows()
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  const group = model.groups.find(g => g.rows.some(r => r.active))
  const row = group?.rows.find(r => r.active)
  if (!row || !group) return <RailInstance />
  const title = streamer
    ? 'Switch account'
    : 'Acting as ' +
      mask(row.display) +
      ' on ' +
      mask(group.name) +
      ' (' +
      mask(group.host) +
      ').' +
      (model.otherBadge ? ' ' + model.otherBadge + ' mentions on other accounts' : '')
  return (
    <div className="w-16">
      <CardButton
        aria-haspopup="dialog"
        data-switcher-tile
        onClick={() => account.store.getState().openDialog({ kind: 'account_switcher' })}
        column
        pad="sm"
        title={title}
        label={title}
        place="w-full"
      >
        <span className="relative">
          <ActorAvatar row={row} size={36} />
          <span className="absolute -right-2 -bottom-1">
            <InstanceTag origin={group.origin} name={group.name} />
          </span>
          {model.otherBadge > 0 && (
            <Inset
              as="span"
              pad="2xs"
              inset="sides"
              look="rounded-full bg-danger text-3xs font-bold text-on-danger"
              place="absolute -left-2 -top-1"
            >
              {model.otherBadge}
            </Inset>
          )}
        </span>
        <Name of={personCalled(row.display)} look="w-full truncate text-xs font-semibold" />
        <Name
          of={instanceName(group.name)}
          look="w-full truncate text-3xs text-on-surface-variant"
        />
      </CardButton>
    </div>
  )
}

// `section` is the open section; null opens the other account's settings on the list of sections.
export function SettingsAccountPicker({ section }: { section: SettingsSection | null }) {
  const owner = useAccount()
  const model = useRows()
  const mask = useMask()
  const rows = model.groups.flatMap(g =>
    g.rows
      .filter(r => r.local === null && r.status !== 'Signed out')
      .map(r => ({ row: r, name: g.name }))
  )
  if (rows.length < 2) return null
  const current = rows.find(({ row }) => switcherSession(row) === owner)
  return (
    <Stack as="label" gap="2xs">
      <span className="text-xs text-on-surface-variant">Settings for</span>
      <NameSelect
        value={current ? keyOf(current.row) : ''}
        className={`max-w-full min-w-28 ${smallFieldCls} text-on-surface`}
        onChange={e => {
          const next = rows.find(({ row }) => keyOf(row) === e.target.value)?.row
          if (!next) return
          void switchActor(next, owner, target => {
            target.store
              .getState()
              .openDialog(section === null ? { kind: 'settings' } : { kind: 'settings', section })
          }).catch(e => owner.store.getState().setError(String(e)))
        }}
      >
        {rows.map(({ row, name }) => (
          <option key={keyOf(row)} value={keyOf(row)}>
            {mask(row.display)} · {mask(name)}
          </option>
        ))}
      </NameSelect>
    </Stack>
  )
}

const ORDER_TARGET: Schema<OrderTarget> = obj({
  origin: str(),
  username: opt(str()),
  local: opt(str()),
})

const sameLevel = (a: OrderTarget, b: OrderTarget) =>
  a.username === undefined
    ? b.username === undefined
    : b.username !== undefined &&
      a.origin === b.origin &&
      (a.local === undefined
        ? b.local === undefined
        : b.local !== undefined && a.username === b.username)

function OrderHandle({
  label: name,
  target,
  index,
  order,
  reorder,
}: {
  label: string
  target: OrderTarget
  index: number
  order: OrderTarget[]
  reorder: (t: OrderTarget, to: OrderTarget) => void
}) {
  const mask = useMask()
  const streamer = useStore(s => s.streamer)
  const label = streamer
    ? target.local
      ? 'identity'
      : target.username
        ? 'account'
        : 'instance'
    : mask(name)
  return (
    <span className="inline-flex shrink-0 items-center">
      <IconButton
        draggable
        data-order-target={JSON.stringify(target)}
        data-order-index={index}
        onDragStart={e => {
          e.dataTransfer.setData('application/x-rchat-order', JSON.stringify(target))
          e.dataTransfer.effectAllowed = 'move'
        }}
        onPointerDown={e => {
          if (e.pointerType === 'touch') e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerUp={e => {
          if (e.pointerType !== 'touch') return
          const el = document
            .elementFromPoint(e.clientX, e.clientY)
            ?.closest<HTMLElement>('[data-order-target]')
          if (!el) return
          const other = parseJson(el.dataset.orderTarget ?? '', ORDER_TARGET)
          if (other.ok && sameLevel(target, other.value)) reorder(target, other.value)
        }}
        icon={GripVertical}
        label={'Drag ' + label}
        size="lg"
        shape="square"
        grip
      ></IconButton>
      <IconButton
        icon={ArrowUp}
        label={'Move ' + label + ' up'}
        tooltip="Move up"
        size="lg"
        shape="square"
        disabled={index === 0}
        onClick={() => reorder(target, order[index - 1])}
      />
      <IconButton
        icon={ArrowDown}
        label={'Move ' + label + ' down'}
        tooltip="Move down"
        size="lg"
        shape="square"
        disabled={index === order.length - 1}
        onClick={() => reorder(target, order[index + 1])}
      />
    </span>
  )
}

function AccountList({
  manage,
  modeChange,
}: {
  manage: boolean
  modeChange?: (manage: boolean) => void
}) {
  const owner = useAccount()
  const model = useRows()
  const canAdd = useAddingAllowed()
  const flat = model.groups.flatMap(g => g.rows)
  const list = useRef<HTMLDivElement>(null)
  const [actions, setActions] = useState<string | null>(null)
  const [adding, setAdding] = useState<SwitcherRow | null>(null)
  const reorder = (from: OrderTarget, to: OrderTarget) =>
    void client.updateBook(book => moveSwitcherRow(book, from, to))
  const drag = (target: OrderTarget, index: number) => ({
    'data-order-target': JSON.stringify(target),
    'data-drop-index': index,
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/x-rchat-order')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData('application/x-rchat-order')
      if (!raw) return
      e.preventDefault()
      e.stopPropagation()
      const from = parseJson(raw, ORDER_TARGET)
      if (from.ok && sameLevel(from.value, target)) reorder(from.value, target)
    },
  })
  const select = (r: SwitcherRow) =>
    void switchActor(r, owner).catch(e => owner.store.getState().setError(String(e)))
  const keys = (e: KeyboardEvent) => {
    if (manage || adding || e.altKey || e.ctrlKey || e.metaKey) return
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('button[data-account-row]') ?? []
    )
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (/^[1-9]$/.test(e.key)) {
      const row = flat[Number(e.key) - 1]
      if (row) {
        e.preventDefault()
        select(row)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
    }
  }
  useEffect(() => {
    if (modeChange && !manage && !adding) {
      const chosen = list.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
      const first = list.current?.querySelector<HTMLButtonElement>('button[data-account-row]')
      ;(chosen ?? first)?.focus()
    }
  }, [modeChange, manage, adding])
  const signOut = (r: SwitcherRow) => {
    const target = switcherSession(r)
    const mark = target?.lifetime.sessionMark()
    const storage = accountStorage(target?.conn ?? savedConnection(r.origin))
    const key = r.username === null ? storage.key('rchat_guest') : storage.token(r.username)
    const credential = readLocal(key)
    owner.store.getState().askConfirm({
      title: 'Sign out of this account?',
      body: 'Other accounts on this device stay signed in.',
      confirm: 'Sign out',
      action: async () => {
        if (
          readLocal(key) !== credential ||
          switcherSession(r) !== target ||
          target?.lifetime.sessionMark() !== mark
        )
          return
        await signOutSwitcherAccount(r.origin, r.username)
        setActions(null)
      },
    })
  }
  const removePeer = (r: SwitcherRow) => {
    const account = switcherSession(r)
    if (account && r.local) confirmIdentityRemoval(owner, account, r.local)
  }
  if (adding) {
    const target = switcherSession(adding)
    if (target) return <IdentityEnrollment account={target} cancel={() => setAdding(null)} />
  }
  return (
    <Stack gap="none" ref={list} onKeyDown={keys} place="min-h-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {model.groups.map((g, gi) => {
          const accounts = g.rows.filter(r => r.local === null && r.username !== null)
          return (
            <section key={g.origin} aria-label={g.name}>
              {(model.groups.length > 1 || manage) && (
                <Surface
                  tone="base"
                  radius="none"
                  pad="md"
                  inset="bar"
                  place="sticky top-0 z-raised"
                  {...drag({ origin: g.origin }, gi)}
                >
                  <Row gap="sm">
                    <InstanceTag origin={g.origin} name={g.name} />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                      <Name of={instanceName(g.name)} />{' '}
                      <Name
                        as="small"
                        of={instanceAddress(g.host)}
                        look="font-normal text-on-surface-variant"
                      />
                    </span>
                    {manage && model.groups.length > 1 && (
                      <OrderHandle
                        label={g.name}
                        target={{ origin: g.origin }}
                        index={gi}
                        order={model.groups}
                        reorder={reorder}
                      />
                    )}
                  </Row>
                </Surface>
              )}
              {g.rows.map(r => {
                const key = keyOf(r),
                  own = !!r.username
                const peers = g.rows.filter(
                  x => x.username === r.username && x.local !== null && x.saved
                )
                const ordered = r.local ? peers : accounts
                const index = ordered.indexOf(r)
                const target = {
                  origin: r.origin,
                  username: r.username ?? undefined,
                  local: r.local ?? undefined,
                }
                const opened = actions === key
                return (
                  <Inset
                    key={key}
                    {...(manage && own && r.saved ? drag(target, index) : {})}
                    pad={r.local ? 'lg' : 'none'}
                    inset="sides"
                  >
                    <Surface tone="plain" radius="none" pad="2xs" inset="bar">
                      <Row gap="2xs">
                        <CardButton
                          data-account-row={key}
                          {...longPress(() => setActions(key))}
                          onClick={() => select(r)}
                          place="min-w-0 flex-1"
                          pad="sm"
                          current={r.active}
                        >
                          <ActorAvatar row={r} size={r.local ? 24 : 32} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              <Name of={accountLabel(r.display)} />{' '}
                              {!r.local && r.username && (
                                <Name
                                  as="small"
                                  of={handleName(r.username, true)}
                                  before="@"
                                  look="font-normal text-on-surface-variant"
                                />
                              )}
                            </span>
                            <span className="block text-xs text-on-surface-variant">
                              {r.local ? 'P2P · ' : ''}
                              {r.status}
                            </span>
                            {r.stale && (
                              <span
                                role="status"
                                title="Could not check this account for new activity. Switch to it to try again."
                                className="block text-xs text-error"
                              >
                                Could not check for new activity
                              </span>
                            )}
                          </span>
                          {r.status === 'Signed out' && (
                            <span className="text-xs text-primary">Sign in</span>
                          )}
                          {r.badge > 0 && (
                            <Surface
                              as="span"
                              pad="sm"
                              inset="sides"
                              tone="secondary"
                              radius="full"
                              text="xs"
                            >
                              {r.badge}
                            </Surface>
                          )}
                          {r.unread && (
                            <span aria-label="Unread" className="size-2 rounded-full bg-primary" />
                          )}
                          {r.active && <Check size={16} aria-label="Acting as" />}
                        </CardButton>
                        {manage && own && r.saved && ordered.length > 1 && (
                          <OrderHandle
                            label={r.display}
                            target={target}
                            index={index}
                            order={ordered.map(row => ({
                              origin: row.origin,
                              username: row.username!,
                              local: row.local ?? undefined,
                            }))}
                            reorder={reorder}
                          />
                        )}
                        {(manage || opened) && (
                          <IconButton
                            icon={MoreHorizontal}
                            label="Account actions"
                            size="lg"
                            shape="square"
                            aria-expanded={opened}
                            onClick={() => setActions(opened ? null : key)}
                          />
                        )}
                      </Row>
                    </Surface>
                    {opened && (
                      <Surface tone="plain" radius="none" pad="sm">
                        <Surface tone="high" radius="lg" pad="2xs" gap="2xs">
                          {own && (
                            <ListRow
                              tone="primary"
                              role="switch"
                              aria-checked={r.background}
                              label={r.local ? 'Run in the background' : 'Keep connected'}
                              onClick={() =>
                                void client.updateBook(b =>
                                  r.local
                                    ? setIdentityBackground(
                                        b,
                                        r.origin,
                                        r.username!,
                                        r.local,
                                        !r.background
                                      )
                                    : setConnected(b, r.origin, r.username!, !r.background)
                                )
                              }
                            />
                          )}
                          {r.local ? (
                            <ListRow
                              tone="primary"
                              label="Remove identity"
                              onClick={() => removePeer(r)}
                            />
                          ) : (
                            <>
                              {own &&
                                switcherSession(r)?.store.getState().settings.p2p &&
                                r.status !== 'Signed out' && (
                                  <ListRow
                                    tone="primary"
                                    label="Add a P2P identity"
                                    onClick={() => {
                                      setAdding(r)
                                    }}
                                  />
                                )}
                              {r.status !== 'Signed out' && (
                                <ListRow
                                  tone="primary"
                                  label="Sign out"
                                  onClick={() => signOut(r)}
                                />
                              )}
                            </>
                          )}
                        </Surface>
                      </Surface>
                    )}
                  </Inset>
                )
              })}
              <Surface tone="plain" radius="none" pad="2xs">
                <ListRow
                  tone="primary"
                  icon={Plus}
                  onClick={() =>
                    owner.store.getState().openDialog({ kind: 'add_instance', origin: g.origin })
                  }
                  label={
                    <>
                      Add an account on <Name of={instanceName(g.name)} />
                    </>
                  }
                />
              </Surface>
            </section>
          )
        })}
      </div>
      {manage && !canAdd && (
        <Surface tone="plain" radius="none" pad="md" inset="bar">
          <p className="text-sm">{hostedLockMessage()}</p>
        </Surface>
      )}
      <Surface as="footer" tone="plain" radius="none" border="top" pad="sm" place="shrink-0">
        <Row gap="2xs" align="stretch" justify="between" wrap>
          {canAdd && (
            <Button
              icon={Plus}
              onClick={() => owner.store.getState().openDialog({ kind: 'add_instance' })}
            >
              Add an instance
            </Button>
          )}
          {modeChange && (
            <Button
              icon={manage ? ChevronLeft : Settings}
              onClick={() => {
                modeChange(!manage)
                setActions(null)
              }}
            >
              {manage ? 'Back to accounts' : 'Manage accounts'}
            </Button>
          )}
        </Row>
      </Surface>
    </Stack>
  )
}

export function ManageAccounts() {
  return (
    <Stack as="section" gap="sm" aria-label="Accounts on this device">
      <h3 className="text-sm font-semibold">Accounts on this device</h3>
      <AccountList manage />
    </Stack>
  )
}

export function SwitcherDialog({ initialManage }: { initialManage: boolean }) {
  const owner = useAccount()
  const [manage, setManage] = useState(initialManage)
  const model = useRows()
  const group = model.groups.find(g => g.rows.some(r => r.active))
  const actor = group?.rows.find(r => r.active)
  const close = owner.store.getState().closeDialog
  const narrow = useMedia(NARROW)
  useEscape(close)
  return (
    <Sheet
      sheet={narrow}
      float={{ at: 'top-2 left-20 max-h-pane w-104', backdrop: 'clear' }}
      surface="base"
      onClose={close}
      aria-label={manage ? 'Manage accounts' : 'Switch account'}
    >
      <Surface as="header" tone="plain" radius="none" pad="lg" inset="bar">
        <Row gap="sm" justify="between">
          <h2 className="font-semibold">
            {manage ? (
              'Manage accounts'
            ) : actor && group ? (
              <Row as="span" gap="2xs" place="inline-flex">
                Acting as <AccountTag row={actor} name={group.name} />
              </Row>
            ) : (
              'Switch account'
            )}
          </h2>
          <IconButton
            icon={X}
            label="Close account switcher"
            size="lg"
            shape="square"
            onClick={close}
          />
        </Row>
      </Surface>
      <AccountList manage={manage} modeChange={setManage} />
    </Sheet>
  )
}
