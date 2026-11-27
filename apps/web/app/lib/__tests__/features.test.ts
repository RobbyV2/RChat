import { describe, expect, test } from 'bun:test'
import {
  FEATURE_KEYS,
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
  'guest_chat_enabled',
  'guest_voice_enabled',
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
  'server_profiles',
  'docs',
  'scheduled_messages',
  'interactive_docs',
]

describe('feature switches', () => {
  test('older servers keep what they had and lack the rest', () => {
    const s = siteSettings(older)
    expect(s.p2p).toBe(true)
    expect(s.password_login).toBe(true)
    expect(s.registration).toBe('open')
    expect(s.p2p_attachments).toBe(true)
    expect(s.client_other_instances).toBe(true)
    expect(s.interactive_docs).toBe(true)
    const kept = ['p2p', 'password_login', 'client_other_instances', 'interactive_docs']
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

  test('profile settings: none before the setting, only narrowing before the choices', () => {
    const before = siteSettings(older)
    expect([before.profile_visibility, before.profile_choices]).toEqual([undefined, undefined])
    const narrowing = siteSettings({ ...older, profile_visibility: 'shared' } as SiteSettings)
    expect([narrowing.profile_visibility, narrowing.profile_choices]).toEqual([
      'shared',
      'narrower',
    ])
    const sent = siteSettings({
      ...older,
      profile_visibility: 'public_servers',
      profile_choices: 'any',
    } as SiteSettings)
    expect([sent.profile_visibility, sent.profile_choices]).toEqual(['public_servers', 'any'])
    const odd = siteSettings({
      ...older,
      profile_visibility: 'friends',
      profile_choices: 'wider',
    } as unknown as SiteSettings)
    expect([odd.profile_visibility, odd.profile_choices]).toEqual(['shared', 'site'])
  })

  test('public reading reads as on when it is missing', () => {
    expect(siteSettings(older).public_reading).toBe(true)
    const off = siteSettings({ ...older, public_reading: false } as SiteSettings)
    expect(off.public_reading).toBe(false)
    const odd = siteSettings({ ...older, public_reading: 'no' } as unknown as SiteSettings)
    expect(odd.public_reading).toBe(true)
  })

  test('temporary password settings read strictly when missing or unknown', () => {
    const before = siteSettings(older)
    expect([before.password_change, before.temp_password_hours]).toEqual(['required', 72])
    const sent = siteSettings({
      ...older,
      password_change: 'encouraged',
      temp_password_hours: 0,
    } as SiteSettings)
    expect([sent.password_change, sent.temp_password_hours]).toEqual(['encouraged', 0])
    const odd = siteSettings({
      ...older,
      password_change: 'optional',
      temp_password_hours: -4,
    } as unknown as SiteSettings)
    expect([odd.password_change, odd.temp_password_hours]).toEqual(['required', 72])
  })

  test('an older instance has every newer control at its open value', () => {
    const s = siteSettings(older)
    expect([s.server_creation, s.dm_creation]).toEqual(['everyone', 'everyone'])
    expect([s.server_search, s.friend_requests, s.calls, s.incoming_webhooks]).toEqual([
      true,
      true,
      true,
      true,
    ])
    const sent = siteSettings({
      ...older,
      server_creation: 'some',
      dm_creation: 'friends',
      server_search: false,
      friend_requests: false,
      calls: false,
      incoming_webhooks: false,
    } as SiteSettings)
    expect([sent.server_creation, sent.dm_creation]).toEqual(['some', 'friends'])
    expect([sent.server_search, sent.friend_requests, sent.calls, sent.incoming_webhooks]).toEqual([
      false,
      false,
      false,
      false,
    ])
    const odd = siteSettings({
      ...older,
      server_creation: 'staff',
      dm_creation: 'mutuals',
    } as unknown as SiteSettings)
    expect([odd.server_creation, odd.dm_creation]).toEqual(['nobody', 'nobody'])
  })

  test('other instances stay allowed unless the instance turns them off', () => {
    expect(siteSettings(older).client_other_instances).toBe(true)
    const off = siteSettings({ ...older, client_other_instances: false } as SiteSettings)
    expect(off.client_other_instances).toBe(false)
    const odd = siteSettings({ ...older, client_other_instances: 0 } as unknown as SiteSettings)
    expect(odd.client_other_instances).toBe(true)
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

  test('the feature keys are the switches', () => {
    const switches: string[] = [...FEATURE_KEYS]
    expect(switches.sort()).toEqual([...SWITCHES].sort())
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
