'use client'

import { ViewActorTag } from './view_actor'
import { useAccount } from '../lib/client/react'
import { client } from '../lib/client/client'
import { friendNames } from '../lib/client/friend_names'
import { useAddingAllowed } from './add_instance'
import {
  useFriendAccounts,
  FriendGroups,
  PeerFriendGroups,
  type FriendAccount,
} from './friends_accounts'
import { AccountTag } from './account_tag'

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Check,
  MessageCircle,
  MoreVertical,
  UserMinus,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { ApiError } from '../lib/api'
import { messageFriend } from '../lib/actions/member'
import { openActionMenu } from '../lib/actions/menu'
import type { Target } from '../lib/actions/types'
import { useMask, useStore } from '../lib/store'
import { bannerColor } from '../lib/profile'
import { scopePings } from '../lib/pings'
import { badgePings } from '../lib/selectors'
import { profileChoiceLine, profileOptions, shownProfileChoice } from '../lib/profile_choice'
import {
  DM_POLICIES,
  FRIENDS_SCOPE,
  FRIEND_TABS,
  HIDDEN_PREVIEW,
  REQUEST_POLICIES,
  relationLabel,
  sendLabel,
  sendable,
  type FriendPreviewState,
  type FriendsTab,
  type Relation,
  type SendResult,
} from '../lib/friends'
import type { ActiveDialog } from '../lib/store_types'
import type { Friend, FriendRequest, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { longPress } from './context_menu'
import { profileTrigger } from './profile_card'
import { PingBadge } from './ping_badge'
import { Button, IconButton, ListRow, Chip, Tab, LinkButton } from './controls'
import { Dialog, fieldCls, FieldError, Masked, PanelHeader, Sentinel, useEscape } from './ui'
import { RowsSkeleton } from './skeletons'

// The unseen friend pings (requests and accepted requests), for badges.
export const useFriendPings = () => useStore(s => scopePings(badgePings(s), FRIENDS_SCOPE))

// The pending incoming request count.
export const useIncomingCount = () => useStore(s => s.friendCounts.incoming)

function Avatar({ user, online, size = 32 }: { user: UserRef; online?: boolean; size?: number }) {
  return (
    <span className="relative shrink-0">
      <UserAvatar
        username={user.username}
        avatarKind={user.avatar_kind}
        avatarColor={user.avatar_color}
        size={size}
      />
      {online !== undefined && (
        <span
          title={online ? 'Online' : 'Offline'}
          aria-label={online ? 'Online' : 'Offline'}
          className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-surface ${
            online ? 'bg-status-green' : 'bg-outline'
          }`}
        />
      )}
    </span>
  )
}

function Name({ user, sub }: { user: UserRef; sub?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="streamer truncate text-sm text-on-surface">
        <Masked text={user.display_name} by={user.username} />
      </span>
      <span className="truncate text-xs text-on-surface-variant">
        <span className="streamer">@{user.username}</span>
        {sub ? ` · ${sub}` : ''}
      </span>
    </span>
  )
}

const rowCls = 'group flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 hover:bg-on-surface/8'

const friendAt = (user: UserRef): Target => ({
  kind: 'member',
  user,
  server: null,
  where: 'friend',
})

export function FriendRow({ friend }: { friend: Friend }) {
  const acct = useAccount()
  const { store } = acct

  const { user, online } = friend
  return (
    <div
      data-friend={user.username}
      {...longPress((x, y) => openActionMenu(x, y, friendAt(user), undefined, acct))}
      className={rowCls}
    >
      <div
        {...profileTrigger(store, user, null)}
        onClickCapture={() => {
          if (client.shown() !== acct) client.show(acct)
        }}
        onKeyDownCapture={e => {
          if ((e.key === 'Enter' || e.key === ' ') && client.shown() !== acct) client.show(acct)
        }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <Avatar user={user} online={online} />
        <Name user={user} sub={online ? 'Online' : 'Offline'} />
      </div>
      <IconButton
        icon={MessageCircle}
        label={`Message ${user.display_name}`}
        tooltip="Message"
        size="lg"
        onClick={() => messageFriend(user, acct)}
      />
      <IconButton
        icon={MoreVertical}
        label={`More for ${user.display_name}`}
        tooltip="More"
        size="lg"
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          openActionMenu(r.left, r.bottom, friendAt(user), undefined, acct)
        }}
      />
    </div>
  )
}

export function RequestRow({ request }: { request: FriendRequest }) {
  const acct = useAccount()
  const { store } = acct

  const acceptFriend = useStore(s => s.acceptFriend)
  const denyFriend = useStore(s => s.denyFriend)
  const cancelFriendRequest = useStore(s => s.cancelFriendRequest)
  const { user, incoming } = request
  return (
    <div
      data-request={user.username}
      {...longPress((x, y) =>
        openActionMenu(
          x,
          y,
          { kind: 'member', user, server: null, where: 'request' },
          undefined,
          acct
        )
      )}
      className={rowCls}
    >
      <div
        {...profileTrigger(store, user, null)}
        onClickCapture={() => {
          if (client.shown() !== acct) client.show(acct)
        }}
        onKeyDownCapture={e => {
          if ((e.key === 'Enter' || e.key === ' ') && client.shown() !== acct) client.show(acct)
        }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <Avatar user={user} />
        <Name user={user} sub={incoming ? 'Incoming request' : 'Outgoing request'} />
      </div>
      {incoming ? (
        <>
          <IconButton
            icon={Check}
            label={`Accept ${user.display_name}`}
            tooltip="Accept"
            tone="primary"
            size="lg"
            onClick={() => void acceptFriend(user)}
          />
          <IconButton
            icon={X}
            label={`Deny ${user.display_name}`}
            tooltip="Deny"
            tone="error"
            size="lg"
            onClick={() => void denyFriend(user.username)}
          />
        </>
      ) : (
        <IconButton
          icon={X}
          label={`Cancel request to ${user.display_name}`}
          tooltip="Cancel request"
          size="lg"
          onClick={() => void cancelFriendRequest(user.username)}
        />
      )}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-6 text-center text-sm text-on-surface-variant">{children}</p>
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-4 pb-1 text-xs font-medium tracking-wide text-on-surface-variant uppercase first:pt-1">
      {children}
    </p>
  )
}

function FriendList({ online, add }: { online: boolean; add?: () => void }) {
  const page = useStore(s => (online ? s.onlineFriends : s.friends))
  const load = useStore(s => (online ? s.loadOnlineFriends : s.loadFriends))
  const setTab = useStore(s => s.setFriendsTab)
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => void load(q, true), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, load])
  const more = useCallback(() => void load(q), [q, load])
  const empty = !page.loading && !page.hasMore && page.list.length === 0
  return (
    <>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search friends"
        aria-label="Search friends"
        className={`${fieldCls} mx-2 mb-2 w-[calc(100%-1rem)] flex-none`}
      />
      <Heading>
        {online ? 'Online' : 'All friends'}
        {!page.hasMore && page.list.length > 0 ? ` · ${page.list.length}` : ''}
      </Heading>
      {page.list.map(f => (
        <FriendRow key={f.user.username} friend={f} />
      ))}
      {page.hasMore && <Sentinel key={page.list.length} onVisible={more} />}
      {empty &&
        (q.trim() ? (
          <Empty>No friends match.</Empty>
        ) : (
          <Empty>
            {online ? 'No friends are online.' : 'No friends yet.'}{' '}
            <LinkButton onClick={add ?? (() => setTab('add'))}>Add friend</LinkButton>
          </Empty>
        ))}
    </>
  )
}

function RequestList({ incoming }: { incoming: boolean }) {
  const page = useStore(s => (incoming ? s.incomingRequests : s.outgoingRequests))
  const load = useStore(s => s.loadFriendRequests)
  useEffect(() => {
    void load(incoming, true)
  }, [incoming, load])
  const more = useCallback(() => void load(incoming), [incoming, load])
  if (!page.loading && !page.hasMore && page.list.length === 0) return null
  return (
    <>
      <Heading>{incoming ? 'Received' : 'Sent'}</Heading>
      {page.list.map(r => (
        <RequestRow key={r.user.username} request={r} />
      ))}
      {page.hasMore && <Sentinel key={page.list.length} onVisible={more} />}
    </>
  )
}

function Pending() {
  const counts = useStore(s => s.friendCounts)
  const loading = useStore(s => s.incomingRequests.loading || s.outgoingRequests.loading)
  return (
    <>
      <RequestList incoming />
      <RequestList incoming={false} />
      {!loading && counts.incoming === 0 && counts.outgoing === 0 && (
        <Empty>No pending friend requests.</Empty>
      )}
    </>
  )
}

// Names typed by hand ("alice bob, carol"), then the preview and confirm dialog.
export function AddFriendBox({
  autoFocus = false,
  entries = [],
  initial,
}: {
  autoFocus?: boolean
  entries?: FriendAccount[]
  initial?: FriendAccount
}) {
  const shown = useAccount()
  const [picked, setPicked] = useState(initial?.account ?? shown)
  const mask = useMask()
  const account =
    entries.find(e => e.account === picked)?.account ??
    (!entries.length && picked === shown ? shown : null)
  const allowed = useAddingAllowed()
  const [hint, setHint] = useState('')
  const [unknown, setUnknown] = useState('')
  const [text, setText] = useState('')
  return (
    <form
      className="flex flex-col gap-2 px-2"
      onSubmit={e => {
        e.preventDefault()
        if (!text.trim() || !account) return
        const choices = entries.map(e => ({
          account: e.account,
          host: e.account.conn.host,
          lastShown: client.accounts.lastShown(e.account),
        }))
        if (!choices.length) choices.push({ account: shown, host: shown.conn.host, lastShown: 0 })
        const result = friendNames(text, account, choices)
        if ('error' in result) {
          setHint(result.error!)
          setUnknown(result.host ?? '')
          if (result.as) setPicked(result.as)
          return
        }
        if (!result.names.length) return
        const entry = entries.find(e => e.account === account)
        if (entry && account.store.getState().me?.username !== entry.row.username) return
        account.store.getState().askAddFriends([...result.names])
        setText('')
        setHint('')
        setUnknown('')
      }}
    >
      {(entries.length > 1 || !account) && (
        <label className="flex items-center gap-2 text-sm">
          As
          <select
            className="streamer rounded-lg bg-surface-container px-2 py-1"
            value={account?.renderKey ?? ''}
            onChange={e => {
              setPicked(entries.find(x => String(x.account.renderKey) === e.target.value)!.account)
              setHint('')
              setUnknown('')
            }}
          >
            {!account && (
              <option disabled value="">
                Choose an account
              </option>
            )}
            {entries.map(x => (
              <option key={x.account.renderKey} value={x.account.renderKey}>
                {mask(x.row.display)} · {mask(x.name)}
              </option>
            ))}
          </select>
        </label>
      )}
      {hint && (
        <p role="alert" className="text-sm text-on-surface-variant">
          {hint}{' '}
          {unknown && allowed && (
            <LinkButton
              onClick={() =>
                shown.store.getState().openDialog({ kind: 'add_instance', origin: unknown })
              }
            >
              Add <span className="streamer">{unknown}</span>
            </LinkButton>
          )}
        </p>
      )}
      <p className="text-sm text-on-surface-variant">
        Add friends by username. Separate several names with spaces.
      </p>
      <div className="flex gap-2">
        <input
          autoFocus={autoFocus}
          value={text}
          onChange={e => {
            setText(e.target.value)
            setHint('')
            setUnknown('')
          }}
          placeholder="Username"
          aria-label="Usernames to add"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={fieldCls}
        />
        <Button type="submit" variant="filled" size="md" disabled={!text.trim() || !account}>
          Next
        </Button>
      </div>
    </form>
  )
}

function Tabs({ tab, entries }: { tab: FriendsTab; entries: FriendAccount[] }) {
  const setTab = useStore(s => s.setFriendsTab)
  const own = useIncomingCount()
  const incoming = useSyncExternalStore(
    fn => {
      const stops = entries.map(e =>
        e.account.store.subscribe((s, p) => {
          if (s.friendCounts !== p.friendCounts) fn()
        })
      )
      return () => stops.forEach(off => off())
    },
    () =>
      entries.length
        ? entries.reduce((n, e) => n + e.account.store.getState().friendCounts.incoming, 0)
        : own,
    () => own
  )
  return (
    <div
      role="tablist"
      aria-label="Friends"
      className="flex shrink-0 gap-1 overflow-x-auto px-2 py-2"
    >
      {FRIEND_TABS.map(t => (
        <Tab key={t.tab} selected={tab === t.tab} onClick={() => setTab(t.tab)} place="shrink-0">
          {t.label}
          {t.tab === 'pending' && <PingBadge count={incoming} />}
        </Tab>
      ))}
    </div>
  )
}

// The friends panel: online, all, pending requests and the add box. Opens from the DM list.
export default function FriendsPanel() {
  const tab = useStore(s => (s.panel?.kind === 'friends' ? s.panel.tab : 'online'))
  const closePanel = useStore(s => s.closePanel)
  const actor = useAccount()
  const entries = useFriendAccounts()
  const [filter, setFilter] = useState<number | null>(null)
  const [addFrom, setAddFrom] = useState<FriendAccount>()
  const multi = entries.length > 1
  const activeFilter = entries.some(e => e.account.renderKey === filter) ? filter : null
  const visible =
    multi && activeFilter !== null
      ? entries.filter(e => e.account.renderKey === activeFilter)
      : entries
  const add = (entry?: FriendAccount) => {
    setAddFrom(entry)
    actor.store.getState().setFriendsTab('add')
  }
  useEscape(closePanel, 'panel')
  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        actor={<ViewActorTag header />}
        icon={Users}
        title="Friends"
        closeTitle="Close friends"
        onClose={closePanel}
      />
      <Tabs tab={tab} entries={visible} />
      {multi && tab !== 'add' && (
        <div
          role="group"
          aria-label="Filter by account"
          className="flex shrink-0 flex-wrap gap-1 px-2 pb-2"
        >
          <Chip on={activeFilter === null} onClick={() => setFilter(null)}>
            All
          </Chip>
          {entries.map(e => (
            <Chip
              key={e.account.renderKey}
              on={activeFilter === e.account.renderKey}
              aria-label={e.row.username + ' on ' + e.name}
              onClick={() => setFilter(e.account.renderKey)}
            >
              <AccountTag row={e.row} name={e.name} />
            </Chip>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
        {tab === 'add' ? (
          <AddFriendBox
            autoFocus
            entries={entries}
            initial={addFrom ?? visible.find(e => e.account.renderKey === activeFilter)}
          />
        ) : multi ? (
          <FriendGroups entries={visible}>
            {e => <PanelList tab={tab} add={() => add(e)} />}
          </FriendGroups>
        ) : (
          <PanelList tab={tab} add={() => add()} />
        )}
        {(tab === 'all' || tab === 'online') &&
          visible.map(e => (
            <PeerFriendGroups key={e.account.renderKey} entry={e} online={tab === 'online'} />
          ))}
      </div>
    </div>
  )
}

function PanelList({ tab, add }: { tab: FriendsTab; add: () => void }) {
  const observe = useStore(s => s.observeFriendsPanel)
  useEffect(observe, [observe])
  const unseen = useFriendPings()
  const mark = useStore(s => s.markFriendsSeen)
  useEffect(() => {
    if (unseen > 0 && document.visibilityState !== 'hidden') mark()
  }, [unseen, mark])
  return tab === 'pending' ? (
    <Pending />
  ) : (
    <FriendList key={tab} online={tab === 'online'} add={add} />
  )
}

// The "Friends" row at the top of the DM list.
export function FriendsEntry({ incomingTotal }: { incomingTotal?: number } = {}) {
  const openFriends = useStore(s => s.openFriends)
  const closePanel = useStore(s => s.closePanel)
  const active = useStore(s => s.panel?.kind === 'friends')
  const pings = useFriendPings()
  const local = useIncomingCount()
  const incoming = incomingTotal ?? local
  const count = incomingTotal ?? Math.max(pings, incoming)
  return (
    <button
      onClick={() => (active ? closePanel() : openFriends(incoming > 0 ? 'pending' : 'online'))}
      aria-pressed={active}
      className={`mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
        active
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
      }`}
    >
      <span className="flex h-7 w-7 items-center justify-center">
        <Users size={18} />
      </span>
      <span className="truncate">Friends</span>
      <PingBadge count={count} className="ml-auto" />
    </button>
  )
}

// For the home page: online friends and pending requests, compact.
export function FriendsSection({ max = 5 }: { max?: number }) {
  const entries = useFriendAccounts()
  return entries.length > 1 ? (
    <FriendGroups entries={entries}>{() => <AccountFriendsSection max={max} />}</FriendGroups>
  ) : (
    <AccountFriendsSection max={max} />
  )
}
function AccountFriendsSection({ max }: { max: number }) {
  const account = useAccount()
  const online = useStore(s => s.onlineFriends)
  const incoming = useStore(s => s.incomingRequests)
  const loadOnline = useStore(s => s.loadOnlineFriends)
  const loadRequests = useStore(s => s.loadFriendRequests)
  const openFriends = useStore(s => s.openFriends)
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    void loadOnline('', true)
    void loadRequests(true, true)
    setAsked(true)
  }, [loadOnline, loadRequests])
  const loading = !asked || online.loading || incoming.loading
  const requests = incoming.list.slice(0, max)
  const friends = online.list.slice(0, max)
  return (
    <section className="flex flex-col">
      {requests.length > 0 && (
        <>
          <Heading>Pending requests</Heading>
          {requests.map(r => (
            <RequestRow key={r.user.username} request={r} />
          ))}
        </>
      )}
      <Heading>Online friends</Heading>
      {friends.length === 0 && loading ? (
        <RowsSkeleton rows={2} label="Loading friends" />
      ) : friends.length === 0 ? (
        <p className="px-2 py-2 text-sm text-on-surface-variant">No friends online right now.</p>
      ) : (
        friends.map(f => <FriendRow key={f.user.username} friend={f} />)
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          onClick={() => {
            if (client.shown() !== account) client.show(account)
            openFriends()
          }}
        >
          All friends
        </Button>
        <Button
          onClick={() => {
            if (client.shown() !== account) client.show(account)
            openFriends('add')
          }}
        >
          Add friend
        </Button>
      </div>
    </section>
  )
}

// Mini profiles and relations of `names`, loaded once per name list.
export function useFriendPreviews(names: string[]) {
  const { api } = useAccount()
  const key = names.join(' ')
  const [previews, setPreviews] = useState<Record<string, FriendPreviewState>>({})
  useEffect(() => {
    let live = true
    for (const name of key.split(' ').filter(Boolean)) {
      void Promise.all([
        api.userProfile(name, null).then(
          p => ({ profile: p, hidden: false }),
          (e: unknown) => ({
            profile: null,
            hidden: e instanceof ApiError && e.status === 404,
          })
        ),
        api.friendship(name).then(
          r => r.status,
          () => 'none' as const
        ),
      ]).then(([p, relation]) => {
        if (live) setPreviews(cur => ({ ...cur, [name]: { ...p, relation } }))
      })
    }
    return () => {
      live = false
    }
  }, [key, api])
  return previews
}

export function FriendPreview({
  name,
  preview,
  result,
}: {
  name: string
  preview: FriendPreviewState | undefined
  result?: SendResult
}) {
  if (!preview)
    return (
      <div className="flex h-20 items-center rounded-2xl bg-surface-container px-4 text-sm text-on-surface-variant">
        Loading <span className="streamer ml-1">@{name}</span>
      </div>
    )
  const { profile, relation, hidden } = preview
  const status = result
    ? result.ok
      ? `${sendLabel(result.status)} ${profile?.user.display_name ?? result.user.display_name}`
      : result.error
    : relationLabel(relation)
  const statusLine = status && (
    <p
      role={result && !result.ok ? 'alert' : undefined}
      className={`mt-1 text-xs ${result && !result.ok ? 'text-error' : 'text-primary'}`}
    >
      <span className="streamer">{status}</span>
    </p>
  )
  if (!profile && hidden)
    return (
      <div data-preview={name} className="rounded-2xl bg-surface-container px-4 py-3">
        <p className="streamer truncate text-sm font-medium text-on-surface">@{name}</p>
        <p className="mt-1 text-xs text-on-surface-variant">{HIDDEN_PREVIEW}</p>
        {statusLine}
      </div>
    )
  if (!profile)
    return (
      <div className="flex items-center rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
        Couldn&apos;t load <span className="streamer ml-1">@{name}</span>
      </div>
    )
  return (
    <div data-preview={name} className="overflow-hidden rounded-2xl bg-surface-container">
      <div
        className="h-8"
        style={{ background: bannerColor(profile.user, profile.banner_color) }}
      />
      <div className="flex items-start gap-3 px-3 pb-3">
        <span className="-mt-4 rounded-full border-4 border-surface-container">
          <Avatar user={profile.user} size={40} />
        </span>
        <div className="min-w-0 flex-1 pt-1">
          <Name user={profile.user} />
          {profile.bio && (
            <p className="mt-1 line-clamp-2 text-xs break-words text-on-surface-variant">
              {profile.bio}
            </p>
          )}
          {statusLine}
        </div>
      </div>
    </div>
  )
}

// The preview list and one confirm for one or several names.
export function AddFriendsDialog() {
  const account = useAccount()
  const dialog = useStore(s => (s.activeDialog?.kind === 'add_friends' ? s.activeDialog : null))
  if (!dialog) return null
  return <AddFriends key={account.renderKey + '/' + dialog.id} dialog={dialog} />
}

function AddFriends({ dialog }: { dialog: Extract<ActiveDialog, { kind: 'add_friends' }> }) {
  const { names } = dialog
  const { store, lifetime } = useAccount()
  const closeDialog = useStore(s => s.closeDialog)
  const sendFriendRequests = useStore(s => s.sendFriendRequests)
  const previews = useFriendPreviews(names)
  const [results, setResults] = useState<Record<string, SendResult> | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = names.every(n => previews[n])
  const targets = names.filter(n => sendable(previews[n]))
  const single = names.length === 1
  const send = async () => {
    if (!targets.length || busy) return
    setBusy(true)
    const at = lifetime.sessionMark()
    const out = await sendFriendRequests(targets)
    if (at !== lifetime.sessionMark() || store.getState().activeDialog !== dialog) return
    setBusy(false)
    if (single && out[targets[0]]?.ok) closeDialog()
    else setResults(out)
  }
  const confirm = !single
    ? `Send ${targets.length} friend requests`
    : previews[names[0]]?.relation === 'incoming'
      ? 'Accept friend request'
      : 'Send friend request'
  return (
    <Dialog title={single ? 'Add friend' : 'Add friends'} onClose={closeDialog}>
      <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
        {names.map(n => (
          <FriendPreview key={n} name={n} preview={previews[n]} result={results?.[n]} />
        ))}
      </div>
      {ready && !targets.length && !results && (
        <FieldError message="There is no one to send a request to." />
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button size="md" onClick={closeDialog}>
          {results ? 'Done' : 'Cancel'}
        </Button>
        {!results && (
          <Button
            variant="filled"
            size="md"
            onClick={() => void send()}
            disabled={!ready || !targets.length || busy}
          >
            {confirm}
          </Button>
        )}
      </div>
    </Dialog>
  )
}

// The friend row for a profile card: Add friend, Accept, Cancel request or Remove friend.
export function ProfileFriendButton({ user, onDone }: { user: UserRef; onDone: () => void }) {
  const { api, store } = useAccount()
  const [relation, setRelation] = useState<Relation | null>(null)
  const rev = useStore(
    s =>
      s.friends.list.length +
      s.incomingRequests.list.length +
      s.outgoingRequests.list.length +
      s.friendCounts.incoming +
      s.friendCounts.outgoing
  )
  useEffect(() => {
    let live = true
    api.friendship(user.username).then(
      r => live && setRelation(r.status),
      () => live && setRelation(null)
    )
    return () => {
      live = false
    }
  }, [user.username, rev])
  if (relation === null) return null
  const s = store.getState()
  const [label, icon, run, danger]: [string, LucideIcon, () => void, boolean] =
    relation === 'friend'
      ? ['Remove friend', UserMinus, () => s.askRemoveFriend(user), true]
      : relation === 'incoming'
        ? ['Accept friend request', Check, () => void s.acceptFriend(user), false]
        : relation === 'outgoing'
          ? ['Cancel friend request', X, () => void s.cancelFriendRequest(user.username), false]
          : ['Add friend', UserPlus, () => s.askAddFriends([user.username]), false]
  return (
    <ListRow
      onClick={() => {
        if (relation === 'friend' || relation === 'none') onDone()
        run()
      }}
      tone={danger ? 'danger' : 'plain'}
      icon={icon}
      label={label}
    />
  )
}

export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | undefined
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-on-surface">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map(o => (
          <Chip
            key={o.value}
            radio
            on={value === o.value}
            disabled={value === undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Chip>
        ))}
      </div>
    </div>
  )
}

// Who can see your profile and find you by name, as far as the site lets you choose.
function ProfileChoiceRow() {
  const privacy = useStore(s => s.privacy)
  const settings = useStore(s => s.settings)
  const setPrivacy = useStore(s => s.setPrivacy)
  const label = 'Who can see your profile and find you by name'
  const options = profileOptions(settings)
  const line = profileChoiceLine(settings)
  if (!settings.profile_visibility) return null
  return (
    <div className="flex flex-col gap-2">
      {options.length > 0 ? (
        <Choice
          label={label}
          value={privacy ? shownProfileChoice(privacy.profile, settings) : undefined}
          options={options}
          onChange={profile => void setPrivacy({ profile })}
        />
      ) : (
        <p className="text-sm text-on-surface">{label}</p>
      )}
      {line && <p className="text-sm text-on-surface-variant">{line}</p>}
      <p className="text-xs text-on-surface-variant">
        Your name still shows next to your messages.
      </p>
    </div>
  )
}

// Settings > Privacy: who can DM you, who can send you friend requests and who can see your
// profile.
export function PrivacyChoices() {
  const privacy = useStore(s => s.privacy)
  const loadPrivacy = useStore(s => s.loadPrivacy)
  const setPrivacy = useStore(s => s.setPrivacy)
  useEffect(() => {
    void loadPrivacy()
  }, [loadPrivacy])
  return (
    <div className="flex flex-col gap-4">
      <Choice
        label="Who can DM you"
        value={privacy?.dms}
        options={DM_POLICIES}
        onChange={dms => void setPrivacy({ dms })}
      />
      <Choice
        label="Who can send you friend requests"
        value={privacy?.friend_requests}
        options={REQUEST_POLICIES}
        onChange={friend_requests => void setPrivacy({ friend_requests })}
      />
      <p className="text-sm text-on-surface-variant">
        With Friends only, only friends can DM you or write in a DM you already have, and you can
        only DM your friends.
      </p>
      <ProfileChoiceRow />
    </div>
  )
}
