import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EMPTY_PAGES,
  NO_FILTERS,
  QUERY_MAX,
  ROLES_MAX,
  allowedFilters,
  chipsOf,
  compareRows,
  dayEnd,
  dayLabel,
  dayOf,
  dayStart,
  dropChip,
  filterMembers,
  filtering,
  hostedQuery,
  lastDay,
  matches,
  p2pMemberRow,
  pageFailed,
  pageLoaded,
  pagesNote,
  parseFilters,
  queryText,
  toggleRole,
  type MemberFilters,
  type MemberRow,
  type SearchPages,
} from '../member_filters'
import { buildSummary, type Summary } from '../p2p/acl/summary'
import type { RoomRecord } from '../p2p/db'
import { LOCAL } from '../p2p/limits'
import { P, PROFILES } from '../p2p/acl/rules'
import { searchBits } from '../p2p/state'
import { serverView } from '../p2p/server/views'
import { AclWorld, devOwner } from './p2p_acl_world'

const ASSET = fileURLToPath(
  new URL('../../../../../assets/member_filter_cases.json', import.meta.url)
)

interface CaseMember {
  username: string
  display_name: string
  server_name?: string
  created_at: number
  joined_at: number
  roles: string[]
  via: string | null
}

interface Case {
  name: string
  query: Record<string, string | number | string[]>
  expect: string[]
}

const table = JSON.parse(readFileSync(ASSET, 'utf8')) as { members: CaseMember[]; cases: Case[] }

// A member of the case table as both sides read it: the username orders by name (as the hosted
// route does) and breaks ties; role and password names stand for their ids.
const rowOf = (m: CaseMember): MemberRow => ({
  key: m.username,
  names: [m.username, m.display_name, ...(m.server_name ? [m.server_name] : [])],
  sortName: m.username,
  roles: m.roles,
  joinedAt: m.joined_at,
  createdAt: m.created_at,
  via: m.via,
})

const paramsOf = (query: Case['query']) =>
  new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
  )

describe('the shared case table', () => {
  test('has cases for every filter and order', () => {
    const keys = new Set(table.cases.flatMap(c => Object.keys(c.query)))
    expect([...keys].sort()).toEqual([
      'created_after',
      'created_before',
      'joined_after',
      'joined_before',
      'q',
      'roles',
      'sort',
      'via',
    ])
    const sorts = new Set(table.cases.map(c => c.query.sort ?? 'name'))
    expect(sorts.size).toBe(5)
  })

  for (const c of table.cases)
    test(c.name, () => {
      const f = parseFilters(paramsOf(c.query))
      expect(filterMembers(f, table.members, rowOf).map(m => m.username)).toEqual(c.expect)
    })

  test('each case reads back from the hosted query it builds', () => {
    for (const c of table.cases) {
      const f = parseFilters(paramsOf(c.query))
      expect(parseFilters(hostedQuery(f))).toEqual(f)
    }
  })
})

describe('the search text', () => {
  test('is trimmed, lowercase and capped', () => {
    expect(queryText('  BoB ')).toBe('bob')
    expect(queryText('a\0b')).toBe('ab')
    expect([...queryText('é'.repeat(40))].length).toBe(QUERY_MAX)
  })

  test('matches any of the names, in any case', () => {
    const r = { ...rowOf(table.members[0]), names: ['zed', 'ÉCLAIR'] }
    expect(matches({ ...NO_FILTERS, q: 'éc' }, r)).toBe(true)
    expect(matches({ ...NO_FILTERS, q: 'ZE' }, r)).toBe(true)
    expect(matches({ ...NO_FILTERS, q: 'x' }, r)).toBe(false)
  })
})

describe('the hosted query', () => {
  test('leaves out what does not narrow and the default order', () => {
    expect(hostedQuery(NO_FILTERS)).toBe('')
    expect(hostedQuery({ ...NO_FILTERS, q: '  ', sort: 'name' })).toBe('')
  })

  test('names every filter the route reads', () => {
    const f: MemberFilters = {
      q: ' Al ',
      roles: ['3', '7'],
      joinedAfter: 10,
      joinedBefore: 20.9,
      createdAfter: 30,
      createdBefore: 40,
      via: '5',
      sort: 'joined_desc',
    }
    expect(hostedQuery(f)).toBe(
      'q=al&roles=3%2C7&joined_after=10&joined_before=20&created_after=30&created_before=40&via=5&sort=joined_desc'
    )
  })

  test('reading a query keeps what it knows and drops the rest', () => {
    expect(
      parseFilters('roles=1,%201,2&roles=3&joined_after=-5&created_before=x&sort=nope&via=%20&q=A')
    ).toEqual({ ...NO_FILTERS, q: 'a', roles: ['1', '2', '3'] })
    const many = Array.from({ length: ROLES_MAX + 5 }, (_, i) => String(i)).join(',')
    expect(parseFilters(`roles=${many}`).roles.length).toBe(ROLES_MAX)
  })
})

describe('orders', () => {
  const row = (key: string, joinedAt: number | null): MemberRow => ({
    key,
    names: [key],
    sortName: key,
    roles: [],
    joinedAt,
    createdAt: null,
    via: null,
  })

  test('members without a time come last both ways', () => {
    const rows = [row('a', null), row('b', 2), row('c', 1)]
    const keys = (sort: 'joined_desc' | 'joined_asc') =>
      [...rows].sort(compareRows(sort)).map(r => r.key)
    expect(keys('joined_desc')).toEqual(['b', 'c', 'a'])
    expect(keys('joined_asc')).toEqual(['c', 'b', 'a'])
  })

  test('a time filter leaves out members without that time', () => {
    expect(matches({ ...NO_FILTERS, joinedAfter: 0 }, row('a', null))).toBe(false)
    expect(matches(NO_FILTERS, row('a', null))).toBe(true)
  })

  test('names can be ordered by another rule', () => {
    const rows = [row('b', 1), row('A', 1), row('a', 1)]
    const ci = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())
    expect(filterMembers(NO_FILTERS, rows, r => r, ci).map(r => r.key)).toEqual(['A', 'a', 'b'])
  })
})

describe('days', () => {
  test('a day range keeps the days it shows', () => {
    const from = dayStart('2026-03-08')!
    const to = dayEnd('2026-03-08')!
    expect(dayOf(from)).toBe('2026-03-08')
    expect(dayOf(to)).toBe('2026-03-09')
    expect(lastDay(to)).toBe('2026-03-08')
    expect(to - from).toBeGreaterThanOrEqual(23 * 3600)
    expect(to - from).toBeLessThanOrEqual(25 * 3600)
  })

  test('what is not a day is none', () => {
    for (const bad of ['', '2026-02-30', '2026-2-3', 'soon']) expect(dayStart(bad)).toBeNull()
    expect(dayEnd('')).toBeNull()
  })

  test('labels are short dates', () => {
    expect(dayLabel(0, { locale: 'en-US', timeZone: 'UTC' })).toBe('Jan 1, 1970')
  })
})

describe('chips', () => {
  const names = {
    role: (id: string) => (id === '1' ? 'Mods' : null),
    via: (id: string) => (id === '9' ? 'Friends' : null),
    date: (t: number) => `d${t}`,
  }

  test('say each filter in use, apart from the search text', () => {
    const f: MemberFilters = {
      ...NO_FILTERS,
      q: 'al',
      roles: ['1', '2'],
      joinedAfter: 100,
      joinedBefore: 200,
      createdBefore: 50,
      via: '9',
    }
    expect(chipsOf(f, names).map(c => c.label)).toEqual([
      'Role: Mods',
      'Role: Unknown',
      'Joined d100 to d199',
      'Account made until d49',
      'Joined with: Friends',
    ])
    expect(chipsOf({ ...NO_FILTERS, createdAfter: 7 }, names).map(c => c.label)).toEqual([
      'Account made since d7',
    ])
    expect(chipsOf(NO_FILTERS, names)).toEqual([])
  })

  test('removing a chip removes its filter alone', () => {
    const f: MemberFilters = {
      ...NO_FILTERS,
      roles: ['1', '2'],
      joinedAfter: 1,
      joinedBefore: 2,
      createdAfter: 3,
      via: '9',
    }
    expect(dropChip(f, { kind: 'role', id: '1' }).roles).toEqual(['2'])
    expect(dropChip(f, { kind: 'joined' })).toMatchObject({ joinedAfter: null, joinedBefore: null })
    expect(dropChip(f, { kind: 'created' }).createdAfter).toBeNull()
    expect(dropChip(f, { kind: 'via' }).via).toBeNull()
    expect(filtering(NO_FILTERS)).toBe(false)
    expect(filtering({ ...NO_FILTERS, sort: 'joined_desc' })).toBe(false)
    expect(filtering({ ...NO_FILTERS, via: '9' })).toBe(true)
  })

  test('roles toggle up to the most a search names', () => {
    let f = NO_FILTERS
    for (let i = 0; i < ROLES_MAX + 3; i++) f = toggleRole(f, String(i))
    expect(f.roles.length).toBe(ROLES_MAX)
    expect(toggleRole(f, '0').roles).not.toContain('0')
  })

  test('a side drops the filters it cannot apply', () => {
    const f: MemberFilters = {
      ...NO_FILTERS,
      createdAfter: 1,
      createdBefore: 2,
      via: '9',
      sort: 'created_desc',
    }
    expect(allowedFilters(f, { created: false, via: false })).toEqual(NO_FILTERS)
    expect(allowedFilters(f, { created: true, via: true })).toEqual(f)
  })
})

// A room where owner O made the code "Friends", N joined with it (at 10 s), U ("Ulla", at 20 s)
// and M (at 30 s) through invites of the owner, U goes by "Skipper" there, and M holds a role that
// may invite.
function room() {
  const w = new AclWorld({ model: false })
  w.genesis('O1', ['O'])
  const inviter = w.ok('O1', 'role_create', { pos: 5, bits: P.Invite }).id
  const code = w.ok('O1', 'code', { h: 'h1', label: 'Friends' })
  w.ok('O1', 'add', { to: devOwner('N1'), code: code.id })
  w.ok('N1', 'join', {}, { ts: 10_000 })
  const joins = new Map<string, string>()
  for (const [dev, ts] of [
    ['U1', 20_000],
    ['M1', 30_000],
  ] as const) {
    w.ok('O1', 'add', { to: devOwner(dev) })
    joins.set(dev, w.ok(dev, 'join', {}, { ts }).id)
  }
  w.ok('O1', 'assign', { to: 'M', role: inviter })
  w.ok('U1', 'profile', { name: 'U', nick: 'Skipper', in: joins.get('U1') })
  const summary = buildSummary({
    ix: w.ref.acl.ix,
    unknownRules: undefined,
    unknownCount: 0,
    gone: new Map(),
    state: () => w.ref.state(),
    evaluation: () => w.ref.acl.evaluation(),
    heads: () => [],
  }).summary
  return { summary, code: code.id }
}

// The member list shows U by the nickname, as it does for someone who is not a contact.
const viewOf = (s: Summary, me: string) =>
  serverView('room', { missing: [], lastSeq: 0, full: false } as unknown as RoomRecord, s, null, {
    me,
    online: () => new Set<string>(),
    name: ik => (ik === 'U' ? 'Skipper' : ik),
    profileName: ik => (ik === 'U' ? 'Ulla' : ik),
    contact: () => false,
    trying: () => false,
    readOnly: () => null,
    frozen: () => false,
    voice: () => ({}),
    syncing: () => false,
    lim: LOCAL,
    now: () => Date.now(),
  })

describe('P2P members', () => {
  test('the summary keeps the code a member joined with', () => {
    const { summary, code } = room()
    expect(summary.members.N).toMatchObject({ codeId: code, codeLabel: 'Friends' })
    expect(summary.members.U.codeId).toBeUndefined()
  })

  test('members who may invite see the code, everyone sees when members joined', () => {
    const { summary, code } = room()
    for (const me of ['O', 'M']) {
      const n = viewOf(summary, me).members.find(m => m.ik === 'N')
      expect(n?.via).toEqual({ id: code, label: 'Friends' })
      expect(n?.joinedAt).toBe(summary.members.N.joinTs!)
    }
    const seen = viewOf(summary, 'U').members.find(m => m.ik === 'N')
    expect(seen?.via).toBeUndefined()
    expect(seen?.joinedAt).toBe(summary.members.N.joinTs!)
  })

  test('the filters run over the room on the device', () => {
    const { summary, code } = room()
    const members = viewOf(summary, 'O').members.filter(m => m.m === 'join')
    const keys = (f: MemberFilters) => filterMembers(f, members, p2pMemberRow).map(m => m.ik)
    expect(keys({ ...NO_FILTERS, via: code })).toEqual(['N'])
    expect(keys({ ...NO_FILTERS, q: 'ull' })).toEqual(['U'])
    const n = summary.members.N.joinTs!
    expect(keys({ ...NO_FILTERS, joinedAfter: Math.floor(n / 1000) + 1 })).not.toContain('N')
    expect(keys({ ...NO_FILTERS, sort: 'joined_desc' })[0]).toBe('M')
    expect(keys({ ...NO_FILTERS, q: 'SKIP' })).toEqual(['U'])
    expect(viewOf(summary, 'O').members.find(m => m.ik === 'U')).toMatchObject({
      name: 'Skipper',
      profileName: 'Ulla',
      nick: 'Skipper',
    })
  })

  test('the search opens with the moderation bits and the one that resets profiles', () => {
    const { summary } = room()
    expect(viewOf(summary, 'O').memberSearch).toBe(true)
    for (const me of ['M', 'U']) expect(viewOf(summary, me).memberSearch).toBeUndefined()
    expect(searchBits(4)).toBe(P.Kick | P.TimeoutMembers | P.ManageRoles)
    expect(searchBits(5)).toBe(P.Kick | P.TimeoutMembers | P.ManageRoles | PROFILES)
  })
})

describe('hosted search pages', () => {
  const hit = (username: string) => ({ username })
  test('pages add up without repeats, and a new search starts over', () => {
    const one = pageLoaded(EMPTY_PAGES, null, [hit('a'), hit('b')], 'c1')
    expect(one).toEqual({
      list: [hit('a'), hit('b')],
      next: 'c1',
      loading: false,
      failed: undefined,
    })
    const two = pageLoaded(one, 'c1', [hit('b'), hit('c')], null)
    expect(two.list.map(h => h.username)).toEqual(['a', 'b', 'c'])
    expect(pageLoaded(two, null, [hit('z')], null).list).toEqual([hit('z')])
  })

  test('a failed page keeps its cursor, waits when told how long, else waits for Try again', () => {
    const one: SearchPages<{ username: string }> = pageLoaded(EMPTY_PAGES, null, [hit('a')], 'c1')
    expect(pageFailed(one, 'c1', 2)).toEqual({
      ...one,
      next: 'c1',
      loading: true,
      failed: undefined,
    })
    const stuck = pageFailed(one, 'c1', null)
    expect(stuck).toEqual({ ...one, next: 'c1', loading: false, failed: 'c1' })
    expect(pageFailed(EMPTY_PAGES, null, null).failed).toBeNull()
  })

  test('the list says no matches only when nothing more can come', () => {
    expect(pagesNote(EMPTY_PAGES)).toBe('Searching…')
    expect(pagesNote({ ...EMPTY_PAGES, loading: false, next: 'c1' })).toBe('Searching…')
    expect(pagesNote({ ...EMPTY_PAGES, loading: false })).toBe('No matching members.')
    expect(pagesNote({ ...EMPTY_PAGES, loading: false, failed: null })).toBe(
      "Couldn't load members."
    )
    expect(pagesNote({ ...EMPTY_PAGES, list: [hit('a')], loading: false })).toBeNull()
  })

  test('a P2P member reads with its lowercase name, join time in seconds and code', () => {
    expect(
      p2pMemberRow({ ik: 'K', name: 'Zoë', roles: ['r'], joinedAt: 12_345, via: { id: 'c' } })
    ).toEqual({
      key: 'K',
      names: ['Zoë'],
      sortName: 'zoë',
      roles: ['r'],
      joinedAt: 12,
      createdAt: null,
      via: 'c',
    })
    expect(p2pMemberRow({ ik: 'K', name: 'A', roles: [] })).toMatchObject({
      joinedAt: null,
      via: null,
    })
    expect(p2pMemberRow({ ik: 'K', name: 'A', nick: 'Skipper', roles: [] }).names).toEqual([
      'A',
      'Skipper',
    ])
    expect(
      p2pMemberRow({ ik: 'K', name: 'Skipper', profileName: 'Alice', nick: 'Skipper', roles: [] })
        .names
    ).toEqual(['Skipper', 'Alice'])
  })
})
