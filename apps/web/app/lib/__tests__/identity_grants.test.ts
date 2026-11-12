import { describe, expect, test } from 'bun:test'
import {
  ACTIVITY_PER_APPLICATION,
  ACTIVITY_PER_GRANT,
  APPLICATION_KINDS,
  ENCRYPTED_REVIEW_SECS,
  activityKeep,
  activityNote,
  capabilities,
  devicesLine,
  encryptedNote,
  kindOk,
  madeByLine,
  menu,
  readsLine,
  removeConfirm,
} from '../identity/grants'

describe('the registry holds applications that sign in and proxy applications, never bots', () => {
  test('kinds', () => {
    expect([...APPLICATION_KINDS]).toEqual(['oauth', 'proxy'])
    expect(kindOk('oauth')).toBe(true)
    expect(kindOk('bot')).toBe(false)
  })
})

describe('a row of Connected applications', () => {
  test('what it can do: the consent lines, strongest first, with their servers and chats', () => {
    const groups = capabilities(
      [
        'openid',
        'profile',
        'servers',
        'messages.read',
        'messages.send',
        'dms.read',
        'encrypted.read',
      ],
      ['lobby', 'team'],
      ['#general, #random']
    )
    expect(groups.map(g => [g.group, g.warning])).toEqual([
      ['Strongest', true],
      ['You', false],
      ['Servers', false],
      ['Messages', false],
    ])
    expect(groups[0].lines).toEqual([
      { line: 'Read the encrypted chats you pick', where: '#general, #random' },
      { line: 'Send, edit and delete your own messages and reactions', where: 'lobby, team' },
      { line: 'Read your direct messages', where: null },
    ])
    expect(groups[2].lines).toEqual([{ line: 'See the servers you pick', where: 'lobby, team' }])
    expect(capabilities(['messages.read'], [], [])[0].lines[0].where).toBeNull()
    expect(capabilities(['made.up'], [], [])).toEqual([])
  })
  test('who made it, and how many devices use it', () => {
    expect(madeByLine({ kind: 'oauth', madeBy: ['Dana', 'Eli'] }, 'Pine Hall')).toBe(
      'Made by Dana, Eli'
    )
    expect(madeByLine({ kind: 'oauth', madeBy: [] }, 'Pine Hall')).toBe('No owner')
    expect(madeByLine({ kind: 'proxy', madeBy: ['Gus'] }, 'Pine Hall')).toBe('Run by Pine Hall')
    expect(madeByLine({ kind: 'proxy', madeBy: [] }, 'chat.example.com')).toBe(
      'Run by chat.example.com'
    )
    expect(devicesLine(3)).toBe('Signed in on 3 devices')
    expect(devicesLine(1)).toBe('Signed in on 1 device')
    expect(devicesLine(0)).toBeNull()
  })
  test('the row menu; encrypted access only in a client that holds the keys', () => {
    const labels = (holdsKeys: boolean, kind: 'oauth' | 'proxy') =>
      menu(holdsKeys, kind).map(m => m.label)
    expect(labels(true, 'oauth')).toEqual([
      'What it did as you',
      'Change what it can do',
      'Give or change encrypted access',
      'Sign out everywhere',
      'Remove',
      'Report',
    ])
    expect(labels(false, 'oauth')).not.toContain('Give or change encrypted access')
    expect(labels(true, 'proxy')).toEqual(['Sign out everywhere', 'Remove', 'Report'])
    expect(menu(true, 'oauth').map(m => m.id)).toEqual([
      'grant.activity',
      'grant.change',
      'grant.encrypted',
      'grant.sign_out',
      'grant.remove',
      'grant.report',
    ])
  })
  test('removing says what ends and what stays', () => {
    expect(removeConfirm('Pixel Board')).toEqual({
      title: 'Remove Pixel Board?',
      text: "It is signed out everywhere, leaves your encrypted chats, and can't use your account. Data it already has is up to the application.",
      option: 'Also delete the webhooks it added',
    })
  })
})

describe('encrypted access states', () => {
  test('a request waits a day for a device with the keys', () => {
    expect(ENCRYPTED_REVIEW_SECS).toBe(24 * 3600)
    expect(encryptedNote('Pixel Board', { state: 'review' })).toEqual({
      text: 'Pixel Board asks to read your encrypted chats',
      action: 'Review',
    })
  })
  test('chats that wait for members on older versions are named', () => {
    expect(encryptedNote('Pixel Board', { state: 'waiting', channels: ['ops'] })).toEqual({
      text: 'Waiting for members to update: #ops',
      action: null,
    })
  })
  test('a device removed after 90 unused days is told and can be added again', () => {
    expect(encryptedNote('Pixel Board', { state: 'unused' })).toEqual({
      text: 'Pixel Board no longer reads your encrypted chats. It was not used for 90 days.',
      action: 'Give access again',
    })
    expect(encryptedNote('Pixel Board', { state: 'on' })).toBeNull()
    expect(encryptedNote('Pixel Board', { state: 'none' })).toBeNull()
    expect(encryptedNote('Pixel Board', { state: 'waiting', channels: [] })).toBeNull()
  })
})

describe('what it did as you', () => {
  test('the trail is capped per grant and per application', () => {
    expect(activityKeep(0, 0)).toBe('detail')
    expect(activityKeep(ACTIVITY_PER_GRANT, 0)).toBe('fold_oldest')
    expect(activityKeep(5, ACTIVITY_PER_APPLICATION)).toBe('counts_only')
    expect(activityNote('counts_only')).toBe('Only daily counts are kept for this application.')
    expect(activityNote('detail')).toBeNull()
    expect(activityNote('fold_oldest')).toBeNull()
  })
  test('reads are shown as counts per place', () => {
    expect(readsLine([{ place: 'lobby', count: 120 }], 4)).toBe('Read 120 messages in lobby, 4 DMs')
    expect(
      readsLine(
        [
          { place: 'lobby', count: 1 },
          { place: 'team', count: 2 },
        ],
        0
      )
    ).toBe('Read 1 message in lobby, 2 messages in team')
    expect(readsLine([], 1)).toBe('Read 1 DM')
    expect(readsLine([], 0)).toBeNull()
  })
})
