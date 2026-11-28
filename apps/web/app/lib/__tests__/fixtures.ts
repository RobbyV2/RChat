import { activeClock, flush } from './helpers/test_clock'
import { jest } from 'bun:test'
import type {
  Channel,
  DmSummary,
  ServerSummary,
  ServerSummaryLite,
  Embed,
  Me,
  Member,
  Message,
  MessageMedia,
  Role,
  SearchResult,
  ServerDetail,
  UserRef,
} from '../types'

const memory = new Map<string, string>()
export const memoryStorage = {
  get length() {
    return memory.size
  },
  key: (i: number) => [...memory.keys()][i] ?? null,
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
}
Object.assign(globalThis, { localStorage: memoryStorage })

// Lets every pending callback and response run, without waiting on any timer.
export const drain = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r))
}

// Polls `done` every tick for up to `ms` of real time, so a fetch chain can finish on a loaded
// runner. Under a test clock it also runs the timers due within `ms`, one per tick. The caller
// asserts afterwards.
export const until = async (done: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  const clock = activeClock()
  const from = clock?.elapsed() ?? 0
  while (!done() && Date.now() < end) {
    await flush()
    if (clock && !done()) clock.step(from + ms - clock.elapsed())
  }
}

// Moves the test clock, or the fake clock (jest.useFakeTimers), `ms` forward one due timer at a time and runs `idle`
// after each, stopping early once `done` holds. A busy machine can't change the outcome, and
// the work is per timer, not per millisecond. A timer that keeps re-arming fails the test.
export const advance = async (ms: number, done = () => false, idle = drain) => {
  const clock = activeClock()
  if (clock) return clock.pass(ms, done, idle)
  let reached = false
  const end = setTimeout(() => (reached = true), ms)
  await idle()
  for (let fired = 0; !reached && !done(); fired += 1) {
    if (fired === 10_000) throw new Error(`advance(${ms}): more than 10000 timers`)
    jest.advanceTimersToNextTimer()
    await idle()
  }
  clearTimeout(end)
}

export const user = (username: string, over: Partial<UserRef> = {}): UserRef => ({
  avatar_image: null,
  username,
  display_name: username,
  avatar_kind: 'identicon',
  avatar_color: null,
  ...over,
})

export const media = (over: Partial<MessageMedia> = {}): MessageMedia => ({
  alt: null,
  sha256: null,
  id: 'm1',
  filename: 'f.png',
  kind: 'server',
  hoster: null,
  expires_at: null,
  size: 10,
  mime: 'image/png',
  removed: false,
  removed_by_author: false,
  spoiler: false,
  ...over,
})

export const msg = (id: number, over: Partial<Message> = {}): Message => ({
  edited_at: null,
  forward: null,
  pin_message_id: null,
  pinned_at: null,
  poll: null,
  reply_to: null,
  webhook: null,
  id,
  channel_id: 1,
  dm_id: null,
  thread_root_id: null,
  author: user('alice'),
  content: 'hi',
  created_at: id,
  reply_count: 0,
  media: null,
  embeds: [],
  kind: 'user',
  call: null,
  ...over,
})

export const embed = (ord: number, over: Partial<Embed> = {}): Embed => ({
  ord,
  url: `https://e${ord}.com`,
  site_name: 'E',
  title: 'T',
  description: 'D',
  image_url: 'https://e.com/i.png',
  banner_removed: false,
  ...over,
})

export const member = (username: string, over: Partial<Member> = {}): Member => ({
  joined_via: null,
  profile: null,
  timeout: null,
  ...user(username),
  is_admin: false,
  is_creator: false,
  online: false,
  perms: 0n,
  role_ids: [],
  ...over,
})

export const textChannel = (id: number): Channel => ({
  id,
  name: `c${id}`,
  kind: 'text',
  slowmode_seconds: 0,
  category_id: null,
  my_perms: null,
  topic: null,
})

// The fields these tests read; the rest stay unset as from an older server (an unset `my_perms` reads
// the permissions from the roles it gives).
export const serverDetail = (name: string, over: Partial<ServerDetail> = {}): ServerDetail =>
  ({
    name,
    display_name: name,
    creator: null,
    has_password: false,
    banner_color: null,
    name_color: null,
    channels: [],
    roles: [],
    role_limits: { held_above: [], channel_grants: [], channel_denies: [] },
    member_count: 0,
    online_count: 0,
    ...over,
  }) as ServerDetail

export const me = (username: string, over: Partial<Me> = {}): Me => ({
  can_create_servers: false,
  delete_at: null,
  has_password: true,
  password_temporary: null,
  ...user(username),
  banner_color: null,
  bio: null,
  is_site_admin: false,
  appear_offline: false,
  password_kind: 'text',
  servers: [],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
  ...over,
})

export const role = (id: number, color: string, perms: bigint): Role => ({
  id,
  name: `r${id}`,
  color,
  perms,
  color_names: true,
  display_position: null,
  hoist: false,
  icon: null,
  mentionable: false,
  position: 0,
})

export const paged = <T>(list: T[]) => ({ list, hasMore: false, loading: false, q: '' })

export const result = (id: number, created_at: number): SearchResult => ({
  message: msg(id, { created_at }),
  server: 's',
  channel_name: 'general',
})

export const NO_SEAL = { on: false, forced: false, own: false, server_forced: false }

export const summary = (name: string, over: Partial<ServerSummary> = {}): ServerSummary => ({
  name,
  display_name: name,
  creator: null,
  is_admin: false,
  banner_color: null,
  icon_image: null,
  icon_kind: 'identicon',
  name_color: null,
  profiles_mode: 'all',
  timed_out_remaining: null,
  timed_out_until: null,
  ...over,
})

export const lite = (name: string, over: Partial<ServerSummaryLite> = {}): ServerSummaryLite => ({
  name,
  display_name: name,
  creator: null,
  has_password: false,
  banner_color: null,
  description: null,
  icon_image: null,
  name_color: null,
  public_read: null,
  seal: NO_SEAL,
  ...over,
})

export const dmWith = (id: number, other: UserRef, over: Partial<DmSummary> = {}): DmSummary => ({
  id,
  other,
  is_self: false,
  closed: false,
  friend: false,
  last_message_at: null,
  last_message_id: null,
  seal: NO_SEAL,
  ...over,
})
