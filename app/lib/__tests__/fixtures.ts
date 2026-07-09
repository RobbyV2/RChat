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
  channels: [],
  roles: [],
  member_count: 0,
  online_count: 0,
  ...over,
})

export const me = (username: string, over: Partial<Me> = {}): Me => ({
  ...user(username),
  is_site_admin: false,
  servers: [],
  dms: [],
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
