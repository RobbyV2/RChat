import { jest } from 'bun:test'
import type {
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
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
}
if (!('localStorage' in globalThis)) Object.assign(globalThis, { localStorage: memoryStorage })

// Lets every pending callback and response run, without waiting on any timer.
export const drain = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r))
}

// Moves the fake clock (jest.useFakeTimers) `ms` forward one due timer at a time and runs `idle`
// after each, stopping early once `done` holds. A busy machine can't change the outcome, and
// the work is per timer, not per millisecond. A timer that keeps re-arming fails the test.
export const advance = async (ms: number, done = () => false, idle = drain) => {
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
  username,
  display_name: username,
  avatar_kind: 'identicon',
  avatar_color: null,
  ...over,
})

export const media = (over: Partial<MessageMedia> = {}): MessageMedia => ({
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
  ...user(username),
  is_admin: false,
  is_creator: false,
  online: false,
  perms: 0,
  role_ids: [],
  ...over,
})

export const serverDetail = (name: string, over: Partial<ServerDetail> = {}): ServerDetail => ({
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
})

export const me = (username: string, over: Partial<Me> = {}): Me => ({
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

export const role = (id: number, color: string, perms: number): Role => ({
  id,
  name: `r${id}`,
  color,
  perms,
})

export const paged = <T>(list: T[]) => ({ list, hasMore: false, loading: false, q: '' })

export const result = (id: number, created_at: number): SearchResult => ({
  message: msg(id, { created_at }),
  server: 's',
  channel_name: 'general',
})
