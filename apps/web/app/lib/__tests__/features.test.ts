import { describe, expect, test } from 'bun:test'
import {
  FEATURE_KEYS,
  FEATURE_ROWS,
  NEW_ACCOUNTS,
  accountPrompt,
  createP2pGate,
  passwordSignup,
  siteSettings,
} from '../features'
import type { SiteSettings } from '../types'

const older = {
  profanity_filter: true,
  profanity_targets: {
    messages: true,
    links: true,
    usernames: true,
    server_names: true,
    channel_names: true,
    role_names: true,
    file_names: true,
    bios: true,
    channel_topics: true,
    category_names: true,
  },
  asset_previews: true,
  asset_uploads: true,
  guests_enabled: true,
} as SiteSettings

const SWITCHES = [
  'server_reports',
  'instance_reports',
  'widgets',
  'widget_chat',
  'widget_read_links',
  'widget_bridge',
  'e2ee',
  'e2ee_compliance',
  'backup_phrase',
  'p2p_backup',
  'display_names',
  'onboarding',
  'password_login',
  'sfu',
  'p2p',
  'client_other_instances',
]

describe('feature switches', () => {
  test('older servers keep what they had and lack the rest', () => {
    const s = siteSettings(older)
    expect(s.p2p).toBe(true)
    expect(s.password_login).toBe(true)
    expect(s.registration).toBe('open')
    expect(s.p2p_attachments).toBe(true)
    expect(s.client_other_instances).toBe(true)
    const kept = ['p2p', 'password_login', 'client_other_instances']
    for (const key of SWITCHES.filter(k => !kept.includes(k)))
      expect([key, s[key as keyof SiteSettings]]).toEqual([key, false])
    expect(passwordSignup(s)).toBe(true)
  })

  test('the switches are read as sent, and bad values fall back', () => {
    const sent = { ...older, p2p: false, e2ee: true, registration: 'sso' } as SiteSettings
    const s = siteSettings(sent)
    expect([s.p2p, s.e2ee, s.registration]).toEqual([false, true, 'sso'])
    const odd = siteSettings({
      ...older,
      p2p: 'no',
      widgets: 1,
      registration: 'invite',
    } as unknown as SiteSettings)
    expect([odd.p2p, odd.widgets, odd.registration]).toEqual([true, false, 'closed'])
    expect(
      siteSettings({ ...older, registration: 5 } as unknown as SiteSettings).registration
    ).toBe('open')
  })

  test('joining reads as an older instance when it is missing', () => {
    expect(siteSettings(older).server_joining).toBe('everyone')
    const sent = siteSettings({ ...older, server_joining: 'invites' } as SiteSettings)
    expect(sent.server_joining).toBe('invites')
    const odd = siteSettings({ ...older, server_joining: 'members' } as unknown as SiteSettings)
    expect(odd.server_joining).toBe('nobody')
  })

  test('public reading reads as on when it is missing', () => {
    expect(siteSettings(older).public_reading).toBe(true)
    const off = siteSettings({ ...older, public_reading: false } as SiteSettings)
    expect(off.public_reading).toBe(false)
    const odd = siteSettings({ ...older, public_reading: 'no' } as unknown as SiteSettings)
    expect(odd.public_reading).toBe(true)
  })

  test('other instances stay allowed unless the instance turns them off', () => {
    expect(siteSettings(older).client_other_instances).toBe(true)
    const off = siteSettings({ ...older, client_other_instances: false } as SiteSettings)
    expect(off.client_other_instances).toBe(false)
    const odd = siteSettings({ ...older, client_other_instances: 0 } as unknown as SiteSettings)
    expect(odd.client_other_instances).toBe(true)
    expect(FEATURE_ROWS.find(r => r.key === 'client_other_instances')).toEqual({
      key: 'client_other_instances',
      label: "Other instances in this site's app",
      line: "Lets people add other instances in this site's web app. Other apps ignore it.",
    })
  })

  test('password sign-up needs open registration and password sign-in', () => {
    const s = siteSettings(older)
    expect(passwordSignup({ ...s, registration: 'open', password_login: true })).toBe(true)
    expect(passwordSignup({ ...s, registration: 'sso' })).toBe(false)
    expect(passwordSignup({ ...s, registration: 'closed' })).toBe(false)
    expect(passwordSignup({ ...s, password_login: false })).toBe(false)
  })

  test('guests are asked to log in once password sign-up is off', () => {
    const s = siteSettings(older)
    expect(accountPrompt(s)).toBe('Create an account')
    expect(accountPrompt({ ...s, registration: 'sso' })).toBe('Log in')
    expect(accountPrompt({ ...s, registration: 'closed' })).toBe('Log in')
    expect(accountPrompt({ ...s, password_login: false })).toBe('Log in')
  })

  test('the Features section lists every switch once with one plain line', () => {
    const switches: string[] = [...FEATURE_KEYS]
    expect(switches.sort()).toEqual([...SWITCHES].sort())
    const keys = FEATURE_ROWS.map(r => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of [
      ...SWITCHES,
      'registration',
      'profanity_filter',
      'asset_previews',
      'asset_uploads',
      'p2p_attachments',
      'guests_enabled',
      'outgoing_webhooks',
    ])
      expect(keys).toContain(key)
    for (const { label, line } of FEATURE_ROWS) {
      expect(label.length).toBeGreaterThan(0)
      expect(line.length).toBeLessThanOrEqual(80)
      expect(line).not.toContain('\n')
      expect(/[—–]/.test(label + line)).toBe(false)
      expect(/rchat/i.test(label + line)).toBe(false)
      expect(line.endsWith('.')).toBe(true)
    }
    expect(NEW_ACCOUNTS.map(o => o.value)).toEqual(['open', 'sso', 'closed'])
  })
})

describe('P2P gate', () => {
  const gate = () => {
    const opened: (string | null)[] = []
    return { opened, g: createP2pGate(u => opened.push(u)) }
  }
  const on = (p2p: boolean) => siteSettings({ ...older, p2p } as SiteSettings)

  test('P2P waits for the instance settings', () => {
    const { opened, g } = gate()
    g.account('bob')
    expect(opened).toEqual([null])
    g.settings(on(true))
    expect(opened).toEqual([null, 'bob'])
  })

  test('turning P2P off stops it, and on starts it again', () => {
    const { opened, g } = gate()
    g.settings(on(true))
    g.account('bob')
    g.settings(on(false))
    g.settings(on(false))
    g.settings(on(true))
    expect(opened).toEqual([null, 'bob', null, 'bob'])
  })

  test('other settings changes leave P2P alone', () => {
    const { opened, g } = gate()
    g.settings(on(true))
    g.account('bob')
    g.settings({ ...on(true), guests_enabled: false })
    expect(opened).toEqual([null, 'bob'])
  })

  test('signing out stops P2P whatever the switch says', () => {
    const { opened, g } = gate()
    g.settings(on(true))
    g.account('bob')
    g.account(null)
    g.settings(on(false))
    g.settings(on(true))
    expect(opened).toEqual([null, 'bob', null, null, null])
  })
})
