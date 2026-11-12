import { describe, expect, test } from 'bun:test'
import {
  ADMIN_NOTE,
  ENCRYPTED_NOTES,
  encryptedMoveNote,
  FINISH_ELSEWHERE,
  PER_SERVER,
  SCOPES,
  allowLabel,
  canGrantHere,
  cleanPicks,
  consentLines,
  consentOrder,
  covers,
  decide,
  defaultPicks,
  defaultTicked,
  deviceLine,
  diff,
  initialTicks,
  isOptional,
  joinLines,
  needsStepUp,
  normalizeTicks,
  pickLine,
  returnLine,
  serversLock,
  toggle,
  waitingLine,
  type Grant,
  type Seen,
} from '../identity/consent'

const application = {
  allowed: [
    'openid',
    'profile',
    'servers',
    'servers.join',
    'messages.read',
    'messages.send',
    'dms.read',
    'friends',
    'admin',
    'encrypted.read',
  ],
  optional: [
    'servers',
    'servers.join',
    'messages.read',
    'messages.send',
    'dms.read',
    'friends',
    'encrypted.read',
  ],
}

describe('the permission list', () => {
  test('part 1 is the simple list; part 2 the whole API in plain words', () => {
    expect(SCOPES.filter(s => s.part === 1).map(s => s.scope)).toEqual([
      'openid',
      'profile',
      'servers',
      'servers.members.read',
      'servers.join',
      'webhook.incoming',
      'offline_access',
    ])
    expect(SCOPES.filter(s => s.part === 2)).toHaveLength(15)
    for (const s of SCOPES) {
      expect(/^[\x20-\x7e]+$/.test(s.line)).toBe(true)
      expect(s.line).not.toContain('RChat')
      expect(s.line.length).toBeLessThanOrEqual(70)
    }
    expect(PER_SERVER).toEqual([
      'servers.members.read',
      'messages.send',
      'moderation',
      'messages.read',
      'servers.read',
      'servers.manage',
      'calls',
    ])
    expect(SCOPES.find(d => d.scope === 'servers.join')!.line).toBe(
      'Join and leave servers for you'
    )
  })
  test("the strongest come first; admin is shown only on a site admin's own screen", () => {
    const asked = ['openid', 'profile', 'messages.read', 'dms.send', 'admin', 'servers']
    const admin = consentOrder(asked, true)
    expect(admin[0].group).toBe('Strongest')
    expect(admin[0].lines.map(l => l.scope)).toEqual(['admin', 'dms.send'])
    expect(consentOrder(asked, false)[0].lines.map(l => l.scope)).toEqual(['dms.send'])
    expect(admin.map(g => g.group)).toEqual(['Strongest', 'You', 'Servers', 'Messages'])
    for (const s of ['admin', 'encrypted.read', 'encrypted.send'])
      expect(SCOPES.find(d => d.scope === s)!.stepUp).toBe(true)
  })
  test('openid and profile are always required; admin is always optional', () => {
    expect(isOptional(application, 'servers')).toBe(true)
    expect(isOptional(application, 'profile')).toBe(false)
    expect(isOptional({ ...application, optional: ['profile'] }, 'profile')).toBe(false)
    expect(isOptional({ ...application, optional: [] }, 'messages.read')).toBe(false)
    expect(isOptional({ ...application, optional: [] }, 'admin')).toBe(true)
  })
})

describe('default ticks', () => {
  test('optional lines start ticked, except the strongest; admin never', () => {
    for (const s of SCOPES) expect(defaultTicked(s.scope)).toBe(!s.strong)
    const asked = [
      'openid',
      'profile',
      'servers',
      'servers.join',
      'messages.send',
      'dms.read',
      'friends',
      'admin',
    ]
    expect(initialTicks(asked, application, true)).toEqual([
      'openid',
      'profile',
      'servers',
      'servers.join',
      'friends',
    ])
    expect(initialTicks(asked, application, false)).toEqual([
      'openid',
      'profile',
      'servers',
      'servers.join',
      'friends',
    ])
  })
  test('a required line is ticked whatever its strength; a required per-server line brings servers along', () => {
    const strict = { allowed: application.allowed, optional: [] }
    expect(initialTicks(['openid', 'profile', 'messages.send'], strict, false)).toEqual([
      'openid',
      'profile',
      'messages.send',
      'servers',
    ])
    expect(initialTicks(['openid', 'admin'], strict, true)).toEqual(['openid'])
  })
})

describe('ticking', () => {
  const asked = [
    'openid',
    'profile',
    'servers',
    'messages.read',
    'messages.send',
    'friends',
    'admin',
  ]
  const start = initialTicks(asked, application, true)
  test('a per-server permission ticks servers and locks it', () => {
    expect(start).toEqual(['openid', 'profile', 'servers', 'messages.read', 'friends'])
    expect(serversLock(start)).toEqual({ locked: true, neededBy: ['Read messages'] })
    expect(toggle(start, 'servers', false, application)).toEqual(start)
    const without = toggle(start, 'messages.read', false, application)
    expect(without).toEqual(['openid', 'profile', 'servers', 'friends'])
    expect(serversLock(without)).toEqual({ locked: false, neededBy: [] })
    expect(toggle(without, 'servers', false, application)).toEqual(['openid', 'profile', 'friends'])
    expect(toggle(['openid', 'profile', 'friends'], 'messages.send', true, application)).toEqual([
      'openid',
      'profile',
      'friends',
      'messages.send',
      'servers',
    ])
    expect(serversLock(['messages.send', 'messages.read', 'servers']).neededBy).toEqual([
      'Send messages',
      'Read messages',
    ])
    expect(normalizeTicks(['openid', 'calls', 'openid'])).toEqual(['openid', 'calls', 'servers'])
  })
  test('required lines can not be unticked; unknown and unasked ones can not be ticked', () => {
    expect(toggle(start, 'openid', false, application)).toEqual(start)
    expect(toggle(start, 'profile', false, application)).toEqual(start)
    const strict = { allowed: application.allowed, optional: ['friends'] }
    expect(toggle(start, 'messages.read', false, strict)).toEqual(start)
    expect(toggle(start, 'email', true, application)).toEqual(start)
    expect(toggle(start, 'moderation', true, application)).toEqual(start)
    expect(toggle(start, 'friends', true, application)).toEqual(start)
  })
  test('ticking admin or an encrypted permission asks for step-up', () => {
    expect(needsStepUp(start)).toBe(false)
    expect(needsStepUp(toggle(start, 'admin', true, application))).toBe(true)
    expect(needsStepUp(['openid', 'encrypted.read'])).toBe(true)
    expect(needsStepUp(['openid', 'messages.send', 'dms.read'])).toBe(false)
  })
})

describe('the lines on the screen', () => {
  const asked = [
    'openid',
    'profile',
    'servers',
    'messages.read',
    'messages.send',
    'admin',
    'encrypted.read',
  ]
  const ticked = initialTicks(asked, application, true)
  test('grouped, strongest first in the warning style, with their notes', () => {
    const groups = consentLines(asked, application, ticked, true, ['lobby', 'team'])
    expect(groups.map(g => [g.group, g.warning])).toEqual([
      ['Strongest', true],
      ['You', false],
      ['Servers', false],
      ['Messages', false],
    ])
    expect(groups[0].lines).toEqual([
      {
        scope: 'admin',
        line: 'Run this site as its admin. This tells the app you are one',
        checkbox: true,
        ticked: false,
        locked: false,
        stepUp: true,
        note: ADMIN_NOTE,
      },
      {
        scope: 'encrypted.read',
        line: 'Read the encrypted chats you pick',
        checkbox: true,
        ticked: false,
        locked: false,
        stepUp: true,
        note: ENCRYPTED_NOTES[0],
      },
      {
        scope: 'messages.send',
        line: 'Send, edit and delete your own messages and reactions',
        checkbox: true,
        ticked: false,
        locked: false,
        stepUp: false,
        note: 'In: lobby, team',
      },
    ])
    expect(groups[1].lines.map(l => [l.scope, l.checkbox, l.ticked])).toEqual([
      ['openid', false, true],
      ['profile', false, true],
    ])
    expect(groups[2].lines).toEqual([
      {
        scope: 'servers',
        line: 'See the servers you pick',
        checkbox: true,
        ticked: true,
        locked: true,
        stepUp: false,
        note: 'Needed by: Read messages',
      },
    ])
    expect(groups[3].lines[0].note).toBe('In: lobby, team')
    expect(ADMIN_NOTE).toBe('Only allow this for a tool this site runs or trusts.')
    expect(ENCRYPTED_NOTES).toEqual(['Everyone in those chats will see it.'])
    expect(encryptedMoveNote('Pixel Board')).toBe(
      "If a channel starts sharing keys with channels you didn't pick, Pixel Board stops reading it until you allow it again."
    )
  })
  test('nobody else sees the admin line, and no server name shows without picks', () => {
    const groups = consentLines(asked, application, ticked, false, [])
    expect(groups[0].lines.map(l => l.scope)).toEqual(['encrypted.read', 'messages.send'])
    expect(groups[0].lines[1].note).toBeNull()
    expect(groups[3].lines[0].note).toBeNull()
  })
  test('joins, the button and the return line', () => {
    expect(joinLines(['lobby', 'events'])).toEqual(['Join lobby for you', 'Join events for you'])
    expect(joinLines([])).toEqual(['Any server you could join'])
    expect(allowLabel('Pixel Board')).toBe('Allow Pixel Board')
    expect(returnLine('pixel.example.com')).toBe("You'll go back to pixel.example.com")
  })
})

describe('the server picker', () => {
  const mine = [
    { key: 'lobby', visibility: 'public' as const },
    { key: 'team', visibility: 'private' as const },
    { key: 'vault', visibility: 'encrypted' as const },
  ]
  test('public ticked, private only when ticked, encrypted never in part 1', () => {
    expect(defaultPicks(mine)).toEqual([
      { key: 'lobby', ticked: true, disabled: false },
      { key: 'team', ticked: false, disabled: false },
      { key: 'vault', ticked: false, disabled: true },
    ])
    expect(cleanPicks(mine, ['lobby', 'team', 'vault', 'lobby', 'elsewhere'])).toEqual([
      'lobby',
      'team',
    ])
  })
})

describe('remembered grants', () => {
  const g: Grant = {
    scopes: ['openid', 'profile', 'servers', 'messages.read'],
    servers: ['lobby'],
    joins: [],
    hosts: ['pixel.example.com'],
    applicationRev: 3,
    revoked: false,
  }
  const ask = {
    scopes: ['openid', 'profile'],
    servers: [],
    joins: [],
    host: 'pixel.example.com',
    applicationRev: 3,
    webhook: false,
    fromClient: false,
  }
  test('covers', () => {
    expect(covers(g, ask)).toBe(true)
    expect(covers(null, ask)).toBe(false)
    expect(covers(g, { ...ask, scopes: ['messages.read'], servers: ['team'] })).toBe(false)
    expect(
      covers({ ...g, servers: null }, { ...ask, scopes: ['messages.read'], servers: ['team'] })
    ).toBe(true)
    expect(covers(g, { ...ask, applicationRev: 4 })).toBe(false)
    expect(covers(g, { ...ask, host: 'pixel2.example.com' })).toBe(false)
    expect(covers(g, { ...ask, webhook: true })).toBe(false)
    expect(covers(g, { ...ask, fromClient: true })).toBe(false)
    expect(covers(g, { ...ask, joins: ['lobby'] })).toBe(false)
    expect(covers({ ...g, revoked: true }, ask)).toBe(false)
    expect(covers({ ...g, scopes: [...g.scopes, 'admin'] }, { ...ask, scopes: ['admin'] })).toBe(
      false
    )
  })
  test('asking again shows only what is new', () => {
    expect(diff(g, { ...ask, scopes: ['openid', 'dms.read'] })).toEqual({
      added: ['dms.read'],
      kept: ['openid'],
    })
    expect(diff(null, { ...ask, scopes: ['openid'] })).toEqual({ added: ['openid'], kept: [] })
    expect(diff(g, { ...ask, applicationRev: 4 }).kept).toEqual([])
  })
})

describe('prompt and remembered grants', () => {
  const s: Seen = {
    accounts: 1,
    chosen: true,
    grantCovers: true,
    authAge: 100,
    totpOn: false,
    sessionTwoKinds: false,
    restricted: false,
    webhook: false,
  }
  const none = new Set(['none'])
  test('silent sign-in', () => {
    expect(decide(none, null, false, s)).toEqual({ kind: 'auto' })
    expect(decide(none, null, false, { ...s, accounts: 0, chosen: false, authAge: null })).toEqual({
      kind: 'error',
      error: 'login_required',
    })
    expect(decide(none, null, false, { ...s, accounts: 2, chosen: false })).toEqual({
      kind: 'error',
      error: 'account_selection_required',
    })
    expect(decide(none, null, false, { ...s, grantCovers: false })).toEqual({
      kind: 'error',
      error: 'consent_required',
    })
    expect(decide(none, 50, false, s)).toEqual({ kind: 'error', error: 'login_required' })
    expect(decide(none, null, true, { ...s, totpOn: true })).toEqual({
      kind: 'error',
      error: 'login_required',
    })
    expect(decide(none, null, false, { ...s, restricted: true })).toEqual({
      kind: 'error',
      error: 'interaction_required',
    })
    expect(decide(none, null, false, { ...s, webhook: true })).toEqual({
      kind: 'error',
      error: 'consent_required',
    })
  })
  test('shown when needed', () => {
    expect(decide(new Set(), null, false, s)).toEqual({ kind: 'auto' })
    expect(decide(new Set(['consent']), null, false, s)).toEqual({
      kind: 'show',
      reauth: false,
      pick: false,
      secondFactor: false,
    })
    expect(decide(new Set(['login']), null, false, s)).toMatchObject({ kind: 'show', reauth: true })
    expect(decide(new Set(), 0, false, s)).toMatchObject({ kind: 'show', reauth: true })
    expect(decide(new Set(), null, true, { ...s, totpOn: true })).toMatchObject({
      kind: 'show',
      secondFactor: true,
    })
    expect(decide(new Set(), null, true, { ...s, totpOn: true, sessionTwoKinds: true })).toEqual({
      kind: 'auto',
    })
    expect(decide(new Set(), null, true, { ...s, totpOn: false })).toEqual({ kind: 'auto' })
    expect(
      decide(new Set(), null, false, { ...s, accounts: 0, chosen: false, authAge: null })
    ).toMatchObject({ kind: 'show', pick: true })
    expect(decide(new Set(['select_account']), null, false, s)).toMatchObject({
      kind: 'show',
      pick: true,
    })
    expect(decide(new Set(), null, false, { ...s, restricted: true })).toMatchObject({
      kind: 'show',
    })
    expect(decide(new Set(), null, false, { ...s, webhook: true })).toMatchObject({ kind: 'show' })
  })
})

describe('encrypted access', () => {
  test('the device count before Allow, and the cap', () => {
    expect(deviceLine(3, 20)).toBe('This adds an encryption device: 4 of 20.')
    expect(deviceLine(20, 20)).toBe('You have 20 of 20 encryption devices. Remove one first.')
  })
  test("the picker shows every channel that shares the group's keys", () => {
    expect(
      pickLine({
        group: 'g',
        channels: [
          { id: 1, name: 'general' },
          { id: 2, name: 'announcements' },
          { id: 3, name: 'random' },
        ],
      })
    ).toBe('These channels share keys: #general, #announcements, #random')
  })
  test('picked chats that wait for members on older versions are named', () => {
    expect(waitingLine(['ops'])).toBe('Waiting for members to update: #ops')
    expect(waitingLine(['ops', 'mods'])).toBe('Waiting for members to update: #ops, #mods')
    expect(waitingLine([])).toBeNull()
  })
  test('granted only in a client that holds the keys', () => {
    expect(canGrantHere({ holdsKeys: true, online: true })).toBe('here')
    expect(canGrantHere({ holdsKeys: false, online: true })).toBe('elsewhere')
    expect(canGrantHere({ holdsKeys: true, online: false })).toBe('elsewhere')
    expect(FINISH_ELSEWHERE).toBe('Finish encrypted access on one of your devices.')
  })
})
