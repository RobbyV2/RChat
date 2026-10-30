'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Check,
  Copy,
  MessageCircle,
  MoreVertical,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { ApiError } from '../lib/api'
import { api } from '../lib/instances'
import { useStore, type ContextMenuItem } from '../lib/store'
import { bannerColor } from '../lib/profile'
import { scopePings } from '../lib/pings'
import { badgePings } from '../lib/selectors'
import {
  DM_POLICIES,
  FRIENDS_SCOPE,
  FRIEND_TABS,
  REQUEST_POLICIES,
  parseNames,
  relationLabel,
  sendLabel,
  type FriendsTab,
  type Relation,
  type SendResult,
} from '../lib/friends'
import type { Friend, FriendRequest, Profile, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { longPress } from './context_menu'
import { blockMenuItem } from './blocking'
import { profileTrigger } from './profile_card'
import { PingBadge } from './ping_badge'
import {
  Dialog,
  fieldCls,
  FieldError,
  filledBtn,
  iconBtn,
  Masked,
  PanelHeader,
  Sentinel,
  SkeletonRows,
  textBtn,
  useEscape,
} from './ui'

// "Add friend" for a user menu; null for yourself, guests and people you blocked.
export const friendMenuItem = (user: UserRef): ContextMenuItem | null => {
  const s = useStore.getState()
  if (!s.me || s.guest || user.username === s.me.username || s.blocked[user.username]) return null
  const known = [s.friends, s.onlineFriends, s.incomingRequests, s.outgoingRequests].some(p =>
    p.list.some((x: { user: UserRef }) => x.user.username === user.username)
  )
  if (known) return null
  return {
    label: 'Add friend',
    icon: UserPlus,
    action: () => useStore.getState().askAddFriends([user.username]),
  }
}

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
        <Masked text={user.display_name} />
      </span>
      <span className="truncate text-xs text-on-surface-variant">
        <span className="streamer">@{user.username}</span>
        {sub ? ` · ${sub}` : ''}
      </span>
    </span>
  )
}

const rowCls =
  'group flex min-h-12 items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-surface-container-high'

// Opens the DM; on narrow screens the full screen panel closes so the DM shows.
const message = (user: UserRef) => {
  const s = useStore.getState()
  if (window.matchMedia('(max-width: 767px)').matches) s.closePanel()
  void s.startDm(user.username)
}

const friendItems = (user: UserRef): ContextMenuItem[] => {
  const s = useStore.getState()
  return [
    {
      label: 'Message',
      icon: MessageCircle,
      action: () => message(user),
    },
    {
      label: 'Remove friend',
      icon: UserMinus,
      danger: true,
      action: () => s.askRemoveFriend(user),
    },
    ...[blockMenuItem(user)].filter(i => i !== null),
    {
      label: 'Copy User ID',
      icon: Copy,
      action: () => void navigator.clipboard.writeText(user.username),
    },
  ]
}

export function FriendRow({ friend }: { friend: Friend }) {
  const openContextMenu = useStore(s => s.openContextMenu)
  const { user, online } = friend
  return (
    <div
      data-friend={user.username}
      {...longPress((x, y) => openContextMenu(x, y, friendItems(user)))}
      className={rowCls}
    >
      <div {...profileTrigger(user, null)} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar user={user} online={online} />
        <Name user={user} sub={online ? 'Online' : 'Offline'} />
      </div>
      <button
        title="Message"
        aria-label={`Message ${user.display_name}`}
        onClick={() => message(user)}
        className={iconBtn}
      >
        <MessageCircle size={18} />
      </button>
      <button
        title="More"
        aria-label={`More for ${user.display_name}`}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          openContextMenu(r.left, r.bottom, friendItems(user))
        }}
        className={iconBtn}
      >
        <MoreVertical size={18} />
      </button>
    </div>
  )
}

export function RequestRow({ request }: { request: FriendRequest }) {
  const acceptFriend = useStore(s => s.acceptFriend)
  const denyFriend = useStore(s => s.denyFriend)
  const cancelFriendRequest = useStore(s => s.cancelFriendRequest)
  const openContextMenu = useStore(s => s.openContextMenu)
  const { user, incoming } = request
  const items = (): ContextMenuItem[] =>
    incoming
      ? [
          { label: 'Accept', icon: Check, action: () => void acceptFriend(user) },
          { label: 'Deny', icon: X, action: () => void denyFriend(user.username) },
          ...[blockMenuItem(user)].filter(i => i !== null),
        ]
      : [
          {
            label: 'Cancel request',
            icon: X,
            action: () => void cancelFriendRequest(user.username),
          },
          ...[blockMenuItem(user)].filter(i => i !== null),
        ]
  return (
    <div
      data-request={user.username}
      {...longPress((x, y) => openContextMenu(x, y, items()))}
      className={rowCls}
    >
      <div {...profileTrigger(user, null)} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar user={user} />
        <Name user={user} sub={incoming ? 'Incoming request' : 'Outgoing request'} />
      </div>
      {incoming ? (
        <>
          <button
            title="Accept"
            aria-label={`Accept ${user.display_name}`}
            onClick={() => void acceptFriend(user)}
            className="rounded-full p-2 text-primary hover:bg-surface-container-highest"
          >
            <Check size={18} />
          </button>
          <button
            title="Deny"
            aria-label={`Deny ${user.display_name}`}
            onClick={() => void denyFriend(user.username)}
            className="rounded-full p-2 text-error hover:bg-surface-container-highest"
          >
            <X size={18} />
          </button>
        </>
      ) : (
        <button
          title="Cancel request"
          aria-label={`Cancel request to ${user.display_name}`}
          onClick={() => void cancelFriendRequest(user.username)}
          className={iconBtn}
        >
          <X size={18} />
        </button>
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

function FriendList({ online }: { online: boolean }) {
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
            <button
              onClick={() => setTab('add')}
              className="font-medium text-primary hover:underline"
            >
              Add friend
            </button>
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
export function AddFriendBox({ autoFocus = false }: { autoFocus?: boolean }) {
  const askAddFriends = useStore(s => s.askAddFriends)
  const [text, setText] = useState('')
  const names = parseNames(text)
  return (
    <form
      className="flex flex-col gap-2 px-2"
      onSubmit={e => {
        e.preventDefault()
        if (!names.length) return
        askAddFriends(names)
        setText('')
      }}
    >
      <p className="text-sm text-on-surface-variant">
        Add friends by username. Separate several names with spaces.
      </p>
      <div className="flex gap-2">
        <input
          autoFocus={autoFocus}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Username"
          aria-label="Usernames to add"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={fieldCls}
        />
        <button type="submit" disabled={!names.length} className={filledBtn}>
          Next
        </button>
      </div>
    </form>
  )
}

function Tabs({ tab }: { tab: FriendsTab }) {
  const setTab = useStore(s => s.setFriendsTab)
  const incoming = useIncomingCount()
  return (
    <div
      role="tablist"
      aria-label="Friends"
      className="flex shrink-0 gap-1 overflow-x-auto px-2 py-2"
    >
      {FRIEND_TABS.map(t => (
        <button
          key={t.tab}
          role="tab"
          aria-selected={tab === t.tab}
          onClick={() => setTab(t.tab)}
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm font-medium ${
            tab === t.tab
              ? t.tab === 'add'
                ? 'bg-primary text-on-primary'
                : 'bg-secondary-container text-on-secondary-container'
              : t.tab === 'add'
                ? 'text-primary hover:bg-surface-container-high'
                : 'text-on-surface-variant hover:bg-surface-container-high'
          }`}
        >
          {t.label}
          {t.tab === 'pending' && <PingBadge count={incoming} />}
        </button>
      ))}
    </div>
  )
}

// The friends panel: online, all, pending requests and the add box. Opens from the DM list.
export default function FriendsPanel() {
  const tab = useStore(s => (s.panel?.kind === 'friends' ? s.panel.tab : 'online'))
  const closePanel = useStore(s => s.closePanel)
  const markFriendsSeen = useStore(s => s.markFriendsSeen)
  const unseen = useFriendPings()
  useEscape(closePanel, 'panel')
  useEffect(() => {
    if (unseen > 0 && document.visibilityState !== 'hidden') markFriendsSeen()
  }, [unseen, markFriendsSeen])
  return (
    <div className="flex h-full flex-col">
      <PanelHeader icon={Users} title="Friends" closeTitle="Close friends" onClose={closePanel} />
      <Tabs tab={tab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
        {tab === 'online' ? (
          <FriendList key="online" online />
        ) : tab === 'all' ? (
          <FriendList key="all" online={false} />
        ) : tab === 'pending' ? (
          <Pending />
        ) : (
          <div className="pt-2">
            <AddFriendBox autoFocus />
          </div>
        )}
      </div>
    </div>
  )
}

// The "Friends" row at the top of the DM list.
export function FriendsEntry() {
  const openFriends = useStore(s => s.openFriends)
  const closePanel = useStore(s => s.closePanel)
  const active = useStore(s => s.panel?.kind === 'friends')
  const pings = useFriendPings()
  const incoming = useIncomingCount()
  const count = Math.max(pings, incoming)
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
        <SkeletonRows rows={2} label="Loading friends" />
      ) : friends.length === 0 ? (
        <p className="px-2 py-2 text-sm text-on-surface-variant">No friends online right now.</p>
      ) : (
        friends.map(f => <FriendRow key={f.user.username} friend={f} />)
      )}
      <div className="flex flex-wrap gap-1">
        <button onClick={() => openFriends()} className={textBtn}>
          All friends
        </button>
        <button onClick={() => openFriends('add')} className={textBtn}>
          Add friend
        </button>
      </div>
    </section>
  )
}

interface Preview {
  profile: Profile | null
  relation: Relation
  missing: boolean
}

// Mini profiles and relations of `names`, loaded once per name list.
export function useFriendPreviews(names: string[]) {
  const key = names.join(' ')
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  useEffect(() => {
    let live = true
    for (const name of key.split(' ').filter(Boolean)) {
      void Promise.all([
        api.userProfile(name, null).then(
          p => ({ profile: p, missing: false }),
          (e: unknown) => ({
            profile: null,
            missing: e instanceof ApiError && e.status === 404,
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
  }, [key])
  return previews
}

export function FriendPreview({
  name,
  preview,
  result,
}: {
  name: string
  preview: Preview | undefined
  result?: SendResult
}) {
  if (!preview)
    return (
      <div className="flex h-20 items-center rounded-2xl bg-surface-container px-4 text-sm text-on-surface-variant">
        Loading <span className="streamer ml-1">@{name}</span>
      </div>
    )
  const { profile, relation, missing } = preview
  if (!profile)
    return (
      <div className="flex items-center rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
        {missing ? 'No user named' : "Couldn't load"} <span className="streamer ml-1">@{name}</span>
      </div>
    )
  const status = result
    ? result.ok
      ? `${sendLabel(result.status)} ${profile.user.display_name}`
      : result.error
    : relationLabel(relation)
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
          {status && (
            <p
              role={result && !result.ok ? 'alert' : undefined}
              className={`mt-1 text-xs ${result && !result.ok ? 'text-error' : 'text-primary'}`}
            >
              <span className="streamer">{status}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// The preview list and one confirm for one or several names.
export function AddFriendsDialog() {
  const names = useStore(s =>
    s.activeDialog?.kind === 'add_friends' ? s.activeDialog.names : null
  )
  if (!names) return null
  return <AddFriends key={names.join(' ')} names={names} />
}

function AddFriends({ names }: { names: string[] }) {
  const closeDialog = useStore(s => s.closeDialog)
  const sendFriendRequests = useStore(s => s.sendFriendRequests)
  const previews = useFriendPreviews(names)
  const [results, setResults] = useState<Record<string, SendResult> | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = names.every(n => previews[n])
  const targets = names.filter(n => {
    const p = previews[n]
    return p?.profile && (p.relation === 'none' || p.relation === 'incoming')
  })
  const single = names.length === 1
  const send = async () => {
    if (!targets.length || busy) return
    setBusy(true)
    const out = await sendFriendRequests(targets)
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
        <button onClick={closeDialog} className={textBtn}>
          {results ? 'Done' : 'Cancel'}
        </button>
        {!results && (
          <button
            onClick={() => void send()}
            disabled={!ready || !targets.length || busy}
            className={filledBtn}
          >
            {confirm}
          </button>
        )}
      </div>
    </Dialog>
  )
}

// The friend row for a profile card: Add friend, Accept, Cancel request or Remove friend.
export function ProfileFriendButton({
  user,
  className,
  onDone,
}: {
  user: UserRef
  className: string
  onDone: () => void
}) {
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
  const s = useStore.getState()
  const [label, icon, run, danger]: [string, ReactNode, () => void, boolean] =
    relation === 'friend'
      ? ['Remove friend', <UserMinus key="i" size={16} />, () => s.askRemoveFriend(user), true]
      : relation === 'incoming'
        ? [
            'Accept friend request',
            <Check key="i" size={16} />,
            () => void s.acceptFriend(user),
            false,
          ]
        : relation === 'outgoing'
          ? [
              'Cancel friend request',
              <X key="i" size={16} />,
              () => void s.cancelFriendRequest(user.username),
              false,
            ]
          : [
              'Add friend',
              <UserPlus key="i" size={16} />,
              () => s.askAddFriends([user.username]),
              false,
            ]
  return (
    <button
      onClick={() => {
        if (relation === 'friend' || relation === 'none') onDone()
        run()
      }}
      className={`${className} ${danger ? 'text-error' : 'text-on-surface'}`}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
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
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            disabled={value === undefined}
            onClick={() => onChange(o.value)}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              value === o.value
                ? 'border-transparent bg-secondary-container text-on-secondary-container'
                : 'border-outline text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// Settings > Privacy: who can DM you and who can send you friend requests.
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
    </div>
  )
}
