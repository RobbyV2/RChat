'use client'
import { ask, asked, together, type Ask } from '../lib/asks'
import { OwnLoadNotice } from './own_load'

import { Loaded, useAccountRequest } from './loaded'
import { orMissing } from '../lib/api_errors'
import { Name, NameSelect } from './name'
import { handleName, personCalled } from '../lib/names'
import { asAccount } from '../lib/people'
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
import { Button, IconButton, ListRow, Chip, Tab, LinkButton, SideRow } from './controls'
import { Dialog, fieldCls, FieldError, PanelHeader, Sentinel, useEscape, smallFieldCls } from './ui'
import { RowsSkeleton } from './skeletons'
import { Row, Stack, Surface, Inset, Lift } from './layout'
import { time } from '../lib/platform/time'

// The unseen friend pings (requests and accepted requests), for badges.
export const useFriendPings = () => useStore(s => scopePings(badgePings(s), FRIENDS_SCOPE))

// The pending incoming request count.
export const useIncomingCount = () => useStore(s => s.friendCounts.incoming)

function Avatar({ user, online, size = 32 }: { user: UserRef; online?: boolean; size?: number }) {
  return (
    <span className="relative shrink-0">
      <UserAvatar person={asAccount(user, 'friend')} size={size} />
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

function FriendName({ user, sub }: { user: UserRef; sub?: string }) {
  return (
    <Stack as="span" gap="none" place="flex-1">
      <Name
        of={personCalled(user.display_name, user.username)}
        look="truncate text-sm text-on-surface"
      />
      <span className="truncate text-xs text-on-surface-variant">
        <Name of={handleName(user.username)} before="@" />
        {sub ? ` · ${sub}` : ''}
      </span>
    </Stack>
  )
}

const rowCls = 'group rounded-lg hover:bg-on-surface/8'

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
      <Surface tone="plain" radius="none" pad="md" inset="bar">
        <Row gap="md">
          <Row
            gap="md"
            place="flex-1"
            {...profileTrigger(store, user, null)}
            onClickCapture={() => {
              if (client.shown() !== acct) client.show(acct)
            }}
            onKeyDownCapture={e => {
              if ((e.key === 'Enter' || e.key === ' ') && client.shown() !== acct) client.show(acct)
            }}
          >
            <Avatar user={user} online={online} />
            <FriendName user={user} sub={online ? 'Online' : 'Offline'} />
          </Row>
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
        </Row>
      </Surface>
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
      <Surface tone="plain" radius="none" pad="md" inset="bar">
        <Row gap="md">
          <Row
            gap="md"
            place="flex-1"
            {...profileTrigger(store, user, null)}
            onClickCapture={() => {
              if (client.shown() !== acct) client.show(acct)
            }}
            onKeyDownCapture={e => {
              if ((e.key === 'Enter' || e.key === ' ') && client.shown() !== acct) client.show(acct)
            }}
          >
            <Avatar user={user} />
            <FriendName user={user} sub={incoming ? 'Incoming request' : 'Outgoing request'} />
          </Row>
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
        </Row>
      </Surface>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Surface tone="plain" radius="none" pad="xl">
      <p className="text-center text-sm text-on-surface-variant">{children}</p>
    </Surface>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <Surface tone="plain" radius="none" pad="sm" inset="bar">
      <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        {children}
      </p>
    </Surface>
  )
}

function FriendList({ online, add }: { online: boolean; add?: () => void }) {
  const page = useStore(s => (online ? s.onlineFriends : s.friends))
  const load = useStore(s => (online ? s.loadOnlineFriends : s.loadFriends))
  const setTab = useStore(s => s.setFriendsTab)
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = time().after(q ? 300 : 0, () => void load(q, true))
    return () => t()
  }, [q, load])
  const more = useCallback(() => void load(q), [q, load])
  const empty = !page.loading && !page.hasMore && page.list.length === 0
  return (
    <Stack gap="sm">
      <Surface tone="plain" radius="none" pad="sm">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search friends"
          aria-label="Search friends"
          className={`${fieldCls} flex-none`}
        />
      </Surface>
      <Stack gap="none">
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
      </Stack>
    </Stack>
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
    <Stack gap="none">
      <Heading>{incoming ? 'Received' : 'Sent'}</Heading>
      {page.list.map(r => (
        <RequestRow key={r.user.username} request={r} />
      ))}
      {page.hasMore && <Sentinel key={page.list.length} onVisible={more} />}
    </Stack>
  )
}

function Pending() {
  const counts = useStore(s => s.friendCounts)
  const loading = useStore(s => s.incomingRequests.loading || s.outgoingRequests.loading)
  const loadFriendSummary = useStore(s => s.loadFriendSummary)
  const resendFriendsSeen = useStore(s => s.resendFriendsSeen)
  return (
    <Stack gap="md">
      <OwnLoadNotice
        what="friend_summary"
        lead="Could not load the friend request counts."
        retry={() => void loadFriendSummary()}
      />
      <OwnLoadNotice
        what="friends_seen"
        lead="Could not mark these requests as seen. Their badge may come back."
        retry={resendFriendsSeen}
      />
      <RequestList incoming />
      <RequestList incoming={false} />
      {!loading && counts.incoming === 0 && counts.outgoing === 0 && (
        <Empty>No pending friend requests.</Empty>
      )}
    </Stack>
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
    <Surface
      as="form"
      tone="plain"
      radius="none"
      pad="sm"
      gap="sm"
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
        <Row as="label" gap="sm">
          <span className="text-sm">As</span>
          <NameSelect
            className={smallFieldCls}
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
          </NameSelect>
        </Row>
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
              Add <Name of={handleName(unknown)} />
            </LinkButton>
          )}
        </p>
      )}
      <p className="text-sm text-on-surface-variant">
        Add friends by username. Separate several names with spaces.
      </p>
      <Row gap="sm" align="stretch">
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
      </Row>
    </Surface>
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
    <Surface
      role="tablist"
      aria-label="Friends"
      tone="plain"
      radius="none"
      pad="sm"
      place="shrink-0 overflow-x-auto"
    >
      <Row gap="2xs">
        {FRIEND_TABS.map(t => (
          <Tab key={t.tab} selected={tab === t.tab} onClick={() => setTab(t.tab)} place="shrink-0">
            {t.label}
            {t.tab === 'pending' && <PingBadge count={incoming} />}
          </Tab>
        ))}
      </Row>
    </Surface>
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
    <Stack gap="none" place="h-full">
      <PanelHeader
        actor={<ViewActorTag header />}
        icon={Users}
        title="Friends"
        closeTitle="Close friends"
        onClose={closePanel}
      />
      <Tabs tab={tab} entries={visible} />
      {multi && tab !== 'add' && (
        <Surface
          role="group"
          aria-label="Filter by account"
          tone="plain"
          radius="none"
          pad="sm"
          place="shrink-0"
        >
          <Row gap="2xs" align="stretch" wrap>
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
          </Row>
        </Surface>
      )}
      <Surface tone="plain" radius="none" pad="sm" gap="md" place="min-h-0 flex-1 overflow-y-auto">
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
      </Surface>
    </Stack>
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
    <SideRow
      onClick={() => (active ? closePanel() : openFriends(incoming > 0 ? 'pending' : 'online'))}
      pressed={active}
    >
      <span className="flex h-7 w-7 items-center justify-center">
        <Users size={18} />
      </span>
      <span className="truncate">Friends</span>
      <PingBadge count={count} className="ml-auto" />
    </SideRow>
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
    <Stack as="section" gap="sm">
      {requests.length > 0 && (
        <Stack gap="none">
          <Heading>Pending requests</Heading>
          {requests.map(r => (
            <RequestRow key={r.user.username} request={r} />
          ))}
        </Stack>
      )}
      <Stack gap="none">
        <Heading>Online friends</Heading>
        {friends.length === 0 && loading ? (
          <RowsSkeleton rows={2} label="Loading friends" />
        ) : friends.length === 0 ? (
          <Surface tone="plain" radius="none" pad="sm">
            <p className="text-sm text-on-surface-variant">No friends online right now.</p>
          </Surface>
        ) : (
          friends.map(f => <FriendRow key={f.user.username} friend={f} />)
        )}
      </Stack>
      <Row gap="2xs" align="stretch" wrap>
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
      </Row>
    </Stack>
  )
}

// The mini profile of `name` and how the account stands with them. A profile that cannot be
// seen is `hidden`; any other failure is the load's.
type PreviewPart = Partial<FriendPreviewState>

const previewOf = (name: string): Ask<readonly [string, FriendPreviewState]> =>
  asked(
    together<PreviewPart>([
      asked(
        ask.userProfile(name, null),
        (profile): PreviewPart => ({ profile, hidden: false }),
        orMissing<PreviewPart>({ profile: null, hidden: true })
      ),
      asked(
        ask.friendship(name),
        (r): PreviewPart => ({ relation: r.status }),
        orMissing<PreviewPart>({ relation: 'none' })
      ),
    ]),
    parts => [name, Object.assign({}, ...parts) as FriendPreviewState] as const
  )

function PreviewLoading({ name }: { name: string }) {
  return (
    <div className="flex h-20 items-center rounded-2xl bg-surface-container">
      <Surface tone="plain" radius="none" pad="lg">
        <p className="text-sm text-on-surface-variant">
          Loading <Name of={handleName(name)} before="@" />
        </p>
      </Surface>
    </div>
  )
}

export function FriendPreview({
  name,
  preview,
  result,
}: {
  name: string
  preview: FriendPreviewState
  result?: SendResult
}) {
  const { profile, relation, hidden } = preview
  const status = result
    ? result.ok
      ? `${sendLabel(result.status)} ${profile?.user.display_name ?? result.user.display_name}`
      : result.error
    : relationLabel(relation)
  const statusLine = status && (
    <p
      role={result && !result.ok ? 'alert' : undefined}
      className={`text-xs ${result && !result.ok ? 'text-error' : 'text-primary'}`}
    >
      <span className="streamer">{status}</span>
    </p>
  )
  if (!profile && hidden)
    return (
      <Surface data-preview={name} tone="base" pad="lg" gap="2xs">
        <Name
          as="p"
          of={handleName(name)}
          before="@"
          look="truncate text-sm font-medium text-on-surface"
        />
        <p className="text-xs text-on-surface-variant">{HIDDEN_PREVIEW}</p>
        {statusLine}
      </Surface>
    )
  if (!profile) return null
  return (
    <div data-preview={name} className="overflow-hidden rounded-2xl bg-surface-container">
      <div
        className="h-8"
        style={{ background: bannerColor(profile.user, profile.banner_color) }}
      />
      <Inset row pad="md" gap="md" align="start">
        <Lift by="lg">
          <span className="block rounded-full border-4 border-surface-container">
            <Avatar user={profile.user} size={40} />
          </span>
        </Lift>
        <Surface tone="plain" radius="none" pad="2xs" gap="2xs" place="flex-1">
          <FriendName user={profile.user} />
          {profile.bio && (
            <p className="line-clamp-2 text-xs break-words text-on-surface-variant">
              {profile.bio}
            </p>
          )}
          {statusLine}
        </Surface>
      </Inset>
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

type AddFriendsAsk = Extract<ActiveDialog, { kind: 'add_friends' }>

function AddFriends({ dialog }: { dialog: AddFriendsAsk }) {
  const { names } = dialog
  const closeDialog = useStore(s => s.closeDialog)
  const single = names.length === 1
  const load = useAccountRequest(
    () => asked(together(names.map(previewOf)), found => Object.fromEntries(found)),
    [names.join(' ')]
  )
  return (
    <Dialog title={single ? 'Add friend' : 'Add friends'} onClose={closeDialog}>
      <Loaded
        load={load}
        what={single ? 'this profile' : 'these profiles'}
        skeleton={
          <Stack gap="sm">
            {names.map(n => (
              <PreviewLoading key={n} name={n} />
            ))}
          </Stack>
        }
      >
        {previews => <AddFriendsForm dialog={dialog} previews={previews} />}
      </Loaded>
    </Dialog>
  )
}

function AddFriendsForm({
  dialog,
  previews,
}: {
  dialog: AddFriendsAsk
  previews: Record<string, FriendPreviewState>
}) {
  const { names } = dialog
  const { store, lifetime } = useAccount()
  const closeDialog = useStore(s => s.closeDialog)
  const sendFriendRequests = useStore(s => s.sendFriendRequests)
  const [results, setResults] = useState<Record<string, SendResult> | null>(null)
  const [busy, setBusy] = useState(false)
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
    <Stack gap="xl">
      <Stack gap="none">
        <div className="max-h-dvh-50 overflow-y-auto">
          <Stack gap="sm">
            {names.map(n => (
              <FriendPreview key={n} name={n} preview={previews[n]} result={results?.[n]} />
            ))}
          </Stack>
        </div>
        {!targets.length && !results && (
          <FieldError message="There is no one to send a request to." />
        )}
      </Stack>
      <Row gap="sm" justify="end">
        <Button size="md" onClick={closeDialog}>
          {results ? 'Done' : 'Cancel'}
        </Button>
        {!results && (
          <Button
            variant="filled"
            size="md"
            onClick={() => void send()}
            disabled={!targets.length || busy}
          >
            {confirm}
          </Button>
        )}
      </Row>
    </Stack>
  )
}

// The friend row for a profile card: Add friend, Accept, Cancel request or Remove friend.
export function ProfileFriendButton({ user, onDone }: { user: UserRef; onDone: () => void }) {
  const rev = useStore(
    s =>
      s.friends.list.length +
      s.incomingRequests.list.length +
      s.outgoingRequests.list.length +
      s.friendCounts.incoming +
      s.friendCounts.outgoing
  )
  const load = useAccountRequest(
    () => asked(ask.friendship(user.username), r => r.status),
    [user.username, rev]
  )
  return (
    <Loaded load={load} skeleton={null} what="the friend status">
      {relation => <FriendAction user={user} relation={relation} onDone={onDone} />}
    </Loaded>
  )
}

function FriendAction({
  user,
  relation,
  onDone,
}: {
  user: UserRef
  relation: Relation
  onDone: () => void
}) {
  const { store } = useAccount()
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
    <Stack gap="sm">
      <p className="text-sm text-on-surface">{label}</p>
      <Row role="radiogroup" aria-label={label} gap="sm" align="stretch" wrap>
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
      </Row>
    </Stack>
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
    <Stack gap="sm">
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
    </Stack>
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
    <Stack gap="lg">
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
    </Stack>
  )
}
