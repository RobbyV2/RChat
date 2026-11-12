export type LimitKey =
  | 'file_mib'
  | 'member_mib'
  | 'app_mib'
  | 'server_mib'
  | 'instance_gib'
  | 'record_kib'
  | 'records'
  | 'text_mib'
  | 'app_text_mib'
  | 'doc_kib'
  | 'doc_versions'
  | 'doc_ops_kib'
  | 'sheet_cells'
  | 'fuel'
  | 'action_writes'
  | 'actions_per_min'
  | 'subs'
  | 'signal_bytes'
  | 'signals_per_sec'
  | 'trash_days'
  | 'changes_days'
  | 'changes_max'
  | 'signal_fanout'
  | 'apps_per_server'
  | 'p2p_doc_mib'
  | 'p2p_holders'
  | 'sub_window'
  | 'sub_interval_ms'
  | 'frames_per_sec'
  | 'frame_kib'
  | 'recheck_max'
  | 'actions_concurrent'
  | 'actions_concurrent_site'
  | 'member_fuel_min'
  | 'action_notifies'
  | 'notify_member_hour'
  | 'notify_per_min'
  | 'posts_per_min'
  | 'signal_users'
  | 'doc_versions_kib'
  | 'file_versions'
  | 'share_links'
  | 'trigger_queue'
  | 'trigger_queue_member'
  | 'apps_per_dm'
  | 'changes_scan'
  | 'pacer_slice'
  | 'late_sign_ms'
  | 'recheck_writes_min'

export interface LimitRow {
  key: LimitKey
  env: string
  def: number
  min: number
  max: number
  unit: string
  what: string
  who: 'operator' | 'operator, owner, author' | 'operator, owner'
}

export const LIMIT_ROWS: LimitRow[] = [
  {
    key: 'file_mib',
    env: 'APP_FILE_MAX_MIB',
    def: 25,
    min: 1,
    max: 512,
    unit: 'MiB',
    what: 'Largest file',
    who: 'operator, owner, author',
  },
  {
    key: 'member_mib',
    env: 'APP_MEMBER_MIB',
    def: 2048,
    min: 0,
    max: 1_048_576,
    unit: 'MiB',
    what: 'Space per member in an app',
    who: 'operator, owner, author',
  },
  {
    key: 'app_mib',
    env: 'APP_STORAGE_MIB',
    def: 10_240,
    min: 0,
    max: 10_485_760,
    unit: 'MiB',
    what: 'Space per app',
    who: 'operator, owner, author',
  },
  {
    key: 'server_mib',
    env: 'APP_SERVER_MIB',
    def: 20_480,
    min: 0,
    max: 10_485_760,
    unit: 'MiB',
    what: 'Space for all apps in a server',
    who: 'operator, owner',
  },
  {
    key: 'instance_gib',
    env: 'APP_INSTANCE_GIB',
    def: 0,
    min: 0,
    max: 1_048_576,
    unit: 'GiB',
    what: 'Space for all apps on this site (0 = no cap)',
    who: 'operator',
  },
  {
    key: 'record_kib',
    env: 'APP_RECORD_KIB',
    def: 64,
    min: 1,
    max: 1024,
    unit: 'KiB',
    what: 'Largest record (fields, not files or documents)',
    who: 'operator, owner, author',
  },
  {
    key: 'records',
    env: 'APP_RECORDS_MAX',
    def: 1_000_000,
    min: 1,
    max: 100_000_000,
    unit: 'records',
    what: 'Records per collection',
    who: 'operator, owner, author',
  },
  {
    key: 'text_mib',
    env: 'APP_TEXT_MIB',
    def: 1024,
    min: 1,
    max: 65_536,
    unit: 'MiB',
    what: 'Kept text per collection',
    who: 'operator, owner, author',
  },
  {
    key: 'app_text_mib',
    env: 'APP_TEXT_TOTAL_MIB',
    def: 4096,
    min: 1,
    max: 262_144,
    unit: 'MiB',
    what: 'Kept text per app',
    who: 'operator, owner, author',
  },
  {
    key: 'doc_kib',
    env: 'APP_DOC_KIB',
    def: 16_384,
    min: 64,
    max: 262_144,
    unit: 'KiB',
    what: 'Largest document or sheet (its current content)',
    who: 'operator, owner, author',
  },
  {
    key: 'doc_versions',
    env: 'APP_DOC_VERSIONS',
    def: 50,
    min: 1,
    max: 10_000,
    unit: 'versions',
    what: 'Saved versions per document',
    who: 'operator, owner, author',
  },
  {
    key: 'doc_versions_kib',
    env: 'APP_DOC_VERSIONS_KIB',
    def: 32_768,
    min: 64,
    max: 1_048_576,
    unit: 'KiB',
    what: 'Space for the saved versions of one document',
    who: 'operator, owner, author',
  },
  {
    key: 'file_versions',
    env: 'APP_FILE_VERSIONS',
    def: 5,
    min: 1,
    max: 1000,
    unit: 'versions',
    what: 'Kept versions of each file',
    who: 'operator, owner, author',
  },
  {
    key: 'doc_ops_kib',
    env: 'APP_DOC_HISTORY_KIB',
    def: 4096,
    min: 256,
    max: 1_048_576,
    unit: 'KiB',
    what: 'Edit history kept per document before it is compacted',
    who: 'operator, owner, author',
  },
  {
    key: 'sheet_cells',
    env: 'APP_SHEET_CELLS',
    def: 200_000,
    min: 1000,
    max: 2_000_000,
    unit: 'cells',
    what: 'Filled cells per sheet tab',
    who: 'operator, owner, author',
  },
  {
    key: 'fuel',
    env: 'APP_ACTION_FUEL',
    def: 50_000_000,
    min: 100_000,
    max: 10_000_000_000,
    unit: 'fuel',
    what: 'Work one action may do',
    who: 'operator, owner, author',
  },
  {
    key: 'member_fuel_min',
    env: 'APP_MEMBER_FUEL_PER_MIN',
    def: 500_000_000,
    min: 100_000,
    max: 100_000_000_000,
    unit: 'fuel a minute',
    what: "Work one member's actions may do",
    who: 'operator, owner, author',
  },
  {
    key: 'actions_concurrent',
    env: 'APP_ACTIONS_CONCURRENT',
    def: 4,
    min: 1,
    max: 64,
    unit: 'at once',
    what: 'Actions running at once in one app',
    who: 'operator, owner',
  },
  {
    key: 'trigger_queue',
    env: 'APP_TRIGGER_QUEUE',
    def: 1000,
    min: 10,
    max: 100_000,
    unit: 'triggers',
    what: 'Triggers one app may have waiting',
    who: 'operator',
  },
  {
    key: 'trigger_queue_member',
    env: 'APP_TRIGGER_QUEUE_MEMBER',
    def: 50,
    min: 1,
    max: 100_000,
    unit: 'triggers',
    what: 'Triggers one member may have waiting in an app',
    who: 'operator',
  },
  {
    key: 'actions_concurrent_site',
    env: 'APP_ACTIONS_CONCURRENT_SITE',
    def: 32,
    min: 1,
    max: 1024,
    unit: 'at once',
    what: 'Actions running at once on this site',
    who: 'operator',
  },
  {
    key: 'action_writes',
    env: 'APP_ACTION_WRITES',
    def: 500,
    min: 1,
    max: 10_000,
    unit: 'writes',
    what: 'Records one action may change',
    who: 'operator, owner, author',
  },
  {
    key: 'actions_per_min',
    env: 'APP_ACTIONS_PER_MIN',
    def: 120,
    min: 1,
    max: 6000,
    unit: 'per minute',
    what: 'Actions per member',
    who: 'operator, owner, author',
  },
  {
    key: 'subs',
    env: 'APP_SUBS',
    def: 64,
    min: 1,
    max: 1024,
    unit: 'subscriptions',
    what: 'Live lists per member per app',
    who: 'operator, owner, author',
  },
  {
    key: 'sub_window',
    env: 'APP_SUB_WINDOW',
    def: 1000,
    min: 50,
    max: 10_000,
    unit: 'records',
    what: 'Records one live list follows',
    who: 'operator, owner, author',
  },
  {
    key: 'sub_interval_ms',
    env: 'APP_SUB_INTERVAL_MS',
    def: 500,
    min: 100,
    max: 60_000,
    unit: 'ms',
    what: 'Shortest time between two updates of one live list',
    who: 'operator',
  },
  {
    key: 'frames_per_sec',
    env: 'APP_FRAMES_PER_SEC',
    def: 4000,
    min: 100,
    max: 1_000_000,
    unit: 'frames a second',
    what: 'Live list updates one server copy sends',
    who: 'operator',
  },
  {
    key: 'frame_kib',
    env: 'APP_FRAME_KIB',
    def: 1024,
    min: 64,
    max: 16_384,
    unit: 'KiB',
    what: 'Largest live update (larger ones become a reload)',
    who: 'operator',
  },
  {
    key: 'recheck_max',
    env: 'APP_RECHECK_MAX',
    def: 2000,
    min: 100,
    max: 100_000,
    unit: 'records',
    what: 'Records one change may mark for another look (past it, the lists that can hold them are checked again in turn)',
    who: 'operator',
  },
  {
    key: 'recheck_writes_min',
    env: 'APP_RECHECK_WRITES_PER_MIN',
    def: 30,
    min: 1,
    max: 10_000,
    unit: 'changes a minute',
    what: "Changes a member may make a minute that other records' rules depend on",
    who: 'operator, owner, author',
  },
  {
    key: 'pacer_slice',
    env: 'APP_PACER_SLICE',
    def: 250,
    min: 10,
    max: 100_000,
    unit: 'frames',
    what: "Live list updates one app sends before the next app's turn",
    who: 'operator',
  },
  {
    key: 'late_sign_ms',
    env: 'APP_LATE_SIGN_MS',
    def: 2000,
    min: 500,
    max: 600_000,
    unit: 'ms',
    what: 'How late a live list is before it says it is catching up',
    who: 'operator',
  },
  {
    key: 'signal_bytes',
    env: 'APP_SIGNAL_BYTES',
    def: 4096,
    min: 64,
    max: 65_536,
    unit: 'bytes',
    what: 'Largest signal',
    who: 'operator, owner, author',
  },
  {
    key: 'signals_per_sec',
    env: 'APP_SIGNALS_PER_SEC',
    def: 20,
    min: 1,
    max: 240,
    unit: 'per second',
    what: 'Signals per member',
    who: 'operator, owner, author',
  },
  {
    key: 'trash_days',
    env: 'APP_TRASH_DAYS',
    def: 30,
    min: 0,
    max: 3650,
    unit: 'days',
    what: 'Days things stay in the trash',
    who: 'operator, owner, author',
  },
  {
    key: 'changes_days',
    env: 'APP_CHANGES_DAYS',
    def: 7,
    min: 1,
    max: 365,
    unit: 'days',
    what: 'Days the change log is kept for catching up',
    who: 'operator',
  },
  {
    key: 'changes_max',
    env: 'APP_CHANGES_MAX',
    def: 100_000,
    min: 1000,
    max: 10_000_000,
    unit: 'entries',
    what: 'Change log entries kept per app',
    who: 'operator',
  },
  {
    key: 'changes_scan',
    env: 'APP_CHANGES_SCAN',
    def: 5000,
    min: 100,
    max: 1_000_000,
    unit: 'entries',
    what: 'Change log entries one read looks through',
    who: 'operator',
  },
  {
    key: 'signal_fanout',
    env: 'APP_SIGNAL_FANOUT',
    def: 500,
    min: 10,
    max: 100_000,
    unit: 'sockets',
    what: 'Sockets one signal reaches',
    who: 'operator',
  },
  {
    key: 'signal_users',
    env: 'APP_SIGNAL_USERS',
    def: 25,
    min: 1,
    max: 500,
    unit: 'members',
    what: 'Members one signal may name',
    who: 'operator, owner, author',
  },
  {
    key: 'action_notifies',
    env: 'APP_ACTION_NOTIFIES',
    def: 100,
    min: 0,
    max: 1000,
    unit: 'members',
    what: 'Members one action run may notify or mention',
    who: 'operator, owner, author',
  },
  {
    key: 'notify_member_hour',
    env: 'APP_NOTIFY_PER_MEMBER_HOUR',
    def: 20,
    min: 0,
    max: 1000,
    unit: 'an hour',
    what: 'Notifications one app sends one member',
    who: 'operator, owner, author',
  },
  {
    key: 'notify_per_min',
    env: 'APP_NOTIFY_PER_MIN',
    def: 120,
    min: 0,
    max: 10_000,
    unit: 'a minute',
    what: 'Notifications one app sends',
    who: 'operator, owner, author',
  },
  {
    key: 'posts_per_min',
    env: 'APP_POSTS_PER_MIN',
    def: 6,
    min: 0,
    max: 600,
    unit: 'a minute',
    what: 'Messages one app posts in one channel',
    who: 'operator, owner',
  },
  {
    key: 'share_links',
    env: 'APP_SHARE_LINKS',
    def: 1000,
    min: 0,
    max: 100_000,
    unit: 'links',
    what: 'Share links per app',
    who: 'operator, owner, author',
  },
  {
    key: 'apps_per_server',
    env: 'APPS_PER_SERVER',
    def: 20,
    min: 0,
    max: 1000,
    unit: 'apps',
    what: 'Apps per server',
    who: 'operator, owner',
  },
  {
    key: 'apps_per_dm',
    env: 'APPS_PER_DM',
    def: 5,
    min: 0,
    max: 100,
    unit: 'apps',
    what: 'Apps in one DM',
    who: 'operator',
  },
  {
    key: 'p2p_doc_mib',
    env: 'APP_P2P_DOC_MIB',
    def: 512,
    min: 1,
    max: 1_048_576,
    unit: 'MiB',
    what: 'Largest P2P document or file',
    who: 'operator, owner, author',
  },
  {
    key: 'p2p_holders',
    env: 'APP_P2P_HOLDERS',
    def: 3,
    min: 1,
    max: 50,
    unit: 'devices',
    what: 'Devices asked to keep a copy of each P2P document',
    who: 'operator, owner, author',
  },
]

export type Limits = Record<LimitKey, number>

export const defaults = (): Limits =>
  Object.fromEntries(LIMIT_ROWS.map(r => [r.key, r.def])) as Limits

// On these rows 0 at a level means no cap from that level.
const ZERO_NONE = new Set<LimitKey>(['member_mib', 'app_mib', 'server_mib', 'instance_gib'])

export const effective = (
  operator: Partial<Limits>,
  owner: Partial<Limits> = {},
  author: Partial<Limits> = {}
): Limits => {
  const out = defaults()
  for (const r of LIMIT_ROWS) {
    const site = operator[r.key] ?? r.def
    if (r.who === 'operator') {
      out[r.key] = Math.max(r.min, Math.min(r.max, site))
      continue
    }
    const vals = [site, owner[r.key], author[r.key]].filter((v): v is number => v !== undefined)
    const set = ZERO_NONE.has(r.key) ? vals.filter(v => v > 0) : vals
    out[r.key] = set.length ? Math.max(r.min, Math.min(...set.map(v => Math.min(r.max, v)))) : 0
  }
  return out
}

export const limitMessage = (key: LimitKey, used: string, cap: string): string => {
  const r = LIMIT_ROWS.find(x => x.key === key)!
  const who =
    r.who === 'operator'
      ? 'The site admin can raise it.'
      : r.who === 'operator, owner'
        ? 'The server owner can raise it up to the site limit.'
        : 'The server owner can raise it up to the site limit; the app may set it lower.'
  return `${r.what}: ${used} of ${cap}. ${who}`
}
