import { describe, expect, test } from 'bun:test'
import {
  defaults,
  effective,
  LIMIT_ROWS,
  limitMessage,
  type LimitKey,
  type LimitRow,
} from '../apps/limits'

type Levels = 'site' | 'site, server' | 'site, server, app'

const WHO: Record<Levels, LimitRow['who']> = {
  site: 'operator',
  'site, server': 'operator, owner',
  'site, server, app': 'operator, owner, author',
}

// The limits table: env name, default, range, levels.
const TABLE: [string, number, number, number, Levels][] = [
  ['APP_FILE_MAX_MIB', 25, 1, 512, 'site, server, app'],
  ['APP_MEMBER_MIB', 2048, 0, 1_048_576, 'site, server, app'],
  ['APP_STORAGE_MIB', 10_240, 0, 10_485_760, 'site, server, app'],
  ['APP_SERVER_MIB', 20_480, 0, 10_485_760, 'site, server'],
  ['APP_INSTANCE_GIB', 0, 0, 1_048_576, 'site'],
  ['APP_RECORD_KIB', 64, 1, 1024, 'site, server, app'],
  ['APP_RECORDS_MAX', 1_000_000, 1, 100_000_000, 'site, server, app'],
  ['APP_TEXT_MIB', 1024, 1, 65_536, 'site, server, app'],
  ['APP_TEXT_TOTAL_MIB', 4096, 1, 262_144, 'site, server, app'],
  ['APP_DOC_KIB', 16_384, 64, 262_144, 'site, server, app'],
  ['APP_DOC_HISTORY_KIB', 4096, 256, 1_048_576, 'site, server, app'],
  ['APP_DOC_VERSIONS', 50, 1, 10_000, 'site, server, app'],
  ['APP_DOC_VERSIONS_KIB', 32_768, 64, 1_048_576, 'site, server, app'],
  ['APP_FILE_VERSIONS', 5, 1, 1000, 'site, server, app'],
  ['APP_SHEET_CELLS', 200_000, 1000, 2_000_000, 'site, server, app'],
  ['APP_ACTION_FUEL', 50_000_000, 100_000, 10_000_000_000, 'site, server, app'],
  ['APP_MEMBER_FUEL_PER_MIN', 500_000_000, 100_000, 100_000_000_000, 'site, server, app'],
  ['APP_ACTIONS_CONCURRENT', 4, 1, 64, 'site, server'],
  ['APP_ACTIONS_CONCURRENT_SITE', 32, 1, 1024, 'site'],
  ['APP_TRIGGER_QUEUE', 1000, 10, 100_000, 'site'],
  ['APP_TRIGGER_QUEUE_MEMBER', 50, 1, 100_000, 'site'],
  ['APP_ACTION_WRITES', 500, 1, 10_000, 'site, server, app'],
  ['APP_ACTIONS_PER_MIN', 120, 1, 6000, 'site, server, app'],
  ['APP_ACTION_NOTIFIES', 100, 0, 1000, 'site, server, app'],
  ['APP_NOTIFY_PER_MEMBER_HOUR', 20, 0, 1000, 'site, server, app'],
  ['APP_NOTIFY_PER_MIN', 120, 0, 10_000, 'site, server, app'],
  ['APP_POSTS_PER_MIN', 6, 0, 600, 'site, server'],
  ['APP_SUBS', 64, 1, 1024, 'site, server, app'],
  ['APP_SUB_WINDOW', 1000, 50, 10_000, 'site, server, app'],
  ['APP_SUB_INTERVAL_MS', 500, 100, 60_000, 'site'],
  ['APP_FRAMES_PER_SEC', 4000, 100, 1_000_000, 'site'],
  ['APP_PACER_SLICE', 250, 10, 100_000, 'site'],
  ['APP_LATE_SIGN_MS', 2000, 500, 600_000, 'site'],
  ['APP_FRAME_KIB', 1024, 64, 16_384, 'site'],
  ['APP_RECHECK_MAX', 2000, 100, 100_000, 'site'],
  ['APP_RECHECK_WRITES_PER_MIN', 30, 1, 10_000, 'site, server, app'],
  ['APP_SIGNAL_BYTES', 4096, 64, 65_536, 'site, server, app'],
  ['APP_SIGNALS_PER_SEC', 20, 1, 240, 'site, server, app'],
  ['APP_SIGNAL_FANOUT', 500, 10, 100_000, 'site'],
  ['APP_SIGNAL_USERS', 25, 1, 500, 'site, server, app'],
  ['APP_SHARE_LINKS', 1000, 0, 100_000, 'site, server, app'],
  ['APP_TRASH_DAYS', 30, 0, 3650, 'site, server, app'],
  ['APP_CHANGES_DAYS', 7, 1, 365, 'site'],
  ['APP_CHANGES_MAX', 100_000, 1000, 10_000_000, 'site'],
  ['APP_CHANGES_SCAN', 5000, 100, 1_000_000, 'site'],
  ['APPS_PER_SERVER', 20, 0, 1000, 'site, server'],
  ['APPS_PER_DM', 5, 0, 100, 'site'],
  ['APP_P2P_DOC_MIB', 512, 1, 1_048_576, 'site, server, app'],
  ['APP_P2P_HOLDERS', 3, 1, 50, 'site, server, app'],
]

const row = (key: string) => LIMIT_ROWS.find(r => r.key === key)

describe('the limit rows', () => {
  test('every row of the limits table is there with its env name, default, range and level', () => {
    expect(LIMIT_ROWS.length).toBe(49)
    expect(TABLE.length).toBe(49)
    for (const [env, def, min, max, levels] of TABLE) {
      const r = LIMIT_ROWS.find(x => x.env === env)
      expect({ env, row: r && { def: r.def, min: r.min, max: r.max, who: r.who } }).toEqual({
        env,
        row: { def, min, max, who: WHO[levels] },
      })
    }
  })

  test('keys and env names are used once, and every default is inside its range', () => {
    expect(new Set(LIMIT_ROWS.map(r => r.env)).size).toBe(LIMIT_ROWS.length)
    expect(new Set(LIMIT_ROWS.map(r => r.key)).size).toBe(LIMIT_ROWS.length)
    for (const r of LIMIT_ROWS) expect(r.def >= r.min && r.def <= r.max).toBe(true)
  })

  test('every limit the text names is a row with an env name and a default', () => {
    for (const [key, env, def] of [
      ['sub_window', 'APP_SUB_WINDOW', 1000],
      ['notify_member_hour', 'APP_NOTIFY_PER_MEMBER_HOUR', 20],
      ['notify_per_min', 'APP_NOTIFY_PER_MIN', 120],
      ['action_notifies', 'APP_ACTION_NOTIFIES', 100],
      ['posts_per_min', 'APP_POSTS_PER_MIN', 6],
      ['sub_interval_ms', 'APP_SUB_INTERVAL_MS', 500],
      ['frames_per_sec', 'APP_FRAMES_PER_SEC', 4000],
      ['frame_kib', 'APP_FRAME_KIB', 1024],
      ['actions_concurrent', 'APP_ACTIONS_CONCURRENT', 4],
      ['member_fuel_min', 'APP_MEMBER_FUEL_PER_MIN', 500_000_000],
      ['fuel', 'APP_ACTION_FUEL', 50_000_000],
      ['doc_versions_kib', 'APP_DOC_VERSIONS_KIB', 32_768],
      ['file_versions', 'APP_FILE_VERSIONS', 5],
      ['signal_users', 'APP_SIGNAL_USERS', 25],
      ['trigger_queue', 'APP_TRIGGER_QUEUE', 1000],
      ['share_links', 'APP_SHARE_LINKS', 1000],
    ] as const)
      expect(row(key)).toMatchObject({ env, def })
  })

  test('the scan, pacer, late-sign, recheck-write, trigger-queue and per-DM rows, each with who may change it', () => {
    const added: [LimitKey, string, number, LimitRow['who']][] = [
      ['changes_scan', 'APP_CHANGES_SCAN', 5000, 'operator'],
      ['pacer_slice', 'APP_PACER_SLICE', 250, 'operator'],
      ['late_sign_ms', 'APP_LATE_SIGN_MS', 2000, 'operator'],
      ['recheck_writes_min', 'APP_RECHECK_WRITES_PER_MIN', 30, 'operator, owner, author'],
      ['trigger_queue_member', 'APP_TRIGGER_QUEUE_MEMBER', 50, 'operator'],
      ['apps_per_dm', 'APPS_PER_DM', 5, 'operator'],
    ]
    for (const [key, env, def, who] of added) expect(row(key)).toMatchObject({ env, def, who })
  })

  test('the recheck row: its key, numbers and words', () => {
    expect(row('recheck_max')).toEqual({
      key: 'recheck_max',
      env: 'APP_RECHECK_MAX',
      def: 2000,
      min: 100,
      max: 100_000,
      unit: 'records',
      what: 'Records one change may mark for another look (past it, the lists that can hold them are checked again in turn)',
      who: 'operator',
    })
  })

  test('labels and units are short plain ASCII', () => {
    for (const r of LIMIT_ROWS) {
      expect(/^[\x20-\x7e]+$/.test(r.what)).toBe(true)
      expect(/^[\x20-\x7e]+$/.test(r.unit)).toBe(true)
      expect(/^[A-Z][A-Z0-9_]+$/.test(r.env)).toBe(true)
    }
  })
})

describe('effective values', () => {
  test('with nothing set, every limit is its default', () => {
    const d = defaults()
    expect(Object.keys(d).length).toBe(49)
    for (const r of LIMIT_ROWS) expect(d[r.key]).toBe(r.def)
    expect(effective({})).toEqual(d)
  })

  test('the lowest set level wins', () => {
    expect(
      effective({ file_versions: 10 }, { file_versions: 3 }, { file_versions: 8 }).file_versions
    ).toBe(3)
    expect(effective({ file_mib: 100 }, { file_mib: 50 }, { file_mib: 10 }).file_mib).toBe(10)
    expect(effective({}, {}, { doc_versions: 5 }).doc_versions).toBe(5)
  })

  test('a lower level cannot raise a limit', () => {
    expect(effective({ file_mib: 10 }, { file_mib: 50 }, { file_mib: 400 }).file_mib).toBe(10)
    expect(effective({}, { subs: 1000 }).subs).toBe(64)
  })

  test('a row only the operator sets ignores the other levels', () => {
    expect(effective({ frames_per_sec: 2000 }, { frames_per_sec: 100_000 }).frames_per_sec).toBe(
      2000
    )
    expect(effective({ frames_per_sec: 2000 }, { frames_per_sec: 100 }).frames_per_sec).toBe(2000)
    expect(effective({}, { apps_per_dm: 0 }, { apps_per_dm: 1 }).apps_per_dm).toBe(5)
  })

  test('values outside a row range are brought inside it', () => {
    expect(effective({ file_mib: 9999 }).file_mib).toBe(512)
    expect(effective({ record_kib: 0 }).record_kib).toBe(1)
    expect(effective({}, { record_kib: -5 }).record_kib).toBe(1)
    expect(effective({ frames_per_sec: 1 }).frames_per_sec).toBe(100)
    expect(effective({ changes_scan: 5_000_000 }).changes_scan).toBe(1_000_000)
  })

  test('a space cap of 0 at a level means no cap from that level', () => {
    expect(effective({ app_mib: 0 }).app_mib).toBe(0)
    expect(effective({ app_mib: 0 }, { app_mib: 500 }).app_mib).toBe(500)
    expect(effective({ app_mib: 1000 }, { app_mib: 0 }, { app_mib: 0 }).app_mib).toBe(1000)
    expect(effective({ member_mib: 0 }, {}, { member_mib: 64 }).member_mib).toBe(64)
    expect(effective({ server_mib: 0 }, { server_mib: 0 }).server_mib).toBe(0)
    expect(effective({}).instance_gib).toBe(0)
    expect(effective({ instance_gib: 50 }).instance_gib).toBe(50)
  })

  test('elsewhere 0 is a value like any other', () => {
    expect(effective({ trash_days: 30 }, { trash_days: 0 }).trash_days).toBe(0)
    expect(effective({}, {}, { action_notifies: 0 }).action_notifies).toBe(0)
    expect(effective({ apps_per_server: 0 }, { apps_per_server: 10 }).apps_per_server).toBe(0)
  })
})

describe('the readout line of a limit', () => {
  test('says which limit, the numbers and who can change it', () => {
    expect(limitMessage('frames_per_sec', '4,100', '4,000')).toBe(
      'Live list updates one server copy sends: 4,100 of 4,000. The site admin can raise it.'
    )
    expect(limitMessage('apps_per_server', '20', '20')).toBe(
      'Apps per server: 20 of 20. The server owner can raise it up to the site limit.'
    )
    expect(limitMessage('file_mib', '30.0 MiB', '25 MiB')).toBe(
      'Largest file: 30.0 MiB of 25 MiB. The server owner can raise it up to the site limit; the app may set it lower.'
    )
  })

  test('is plain ASCII for every row', () => {
    for (const r of LIMIT_ROWS)
      expect(/^[\x20-\x7e]+$/.test(limitMessage(r.key, '2', '1'))).toBe(true)
  })
})
