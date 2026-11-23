import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsMenu from '../../components/settings_menu'
import { peerStorage } from '../client/keys'
import { paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { paletteCommands } from '../actions/palette'
import { runAction } from '../actions/registry'
import { home } from '../instances'
import { p2pKey, useP2p } from '../p2p/app'
import { resetSessionCaches, useStore } from '../store'
import type { ActiveDialog, RChatState } from '../store_types'
import type { P2pState } from '../p2p/app/store'
import { me } from './fixtures'

const alicePeerFlag = () => peerStorage(home, 'alice').scoped(p2pKey('alice'))
const initial = useStore.getInitialState()
const saved = { ...initial }
const p2pInitial = useP2p.getInitialState()
const p2pSaved = { ...p2pInitial }

// A static render reads the initial state through hooks and the current one outside them.
const seed = (state: Partial<RChatState>, p2p: Partial<P2pState> = {}) => {
  localStorage.removeItem(alicePeerFlag())
  Object.assign(initial, state)
  useStore.setState(state)
  Object.assign(p2pInitial, p2p)
  useP2p.setState(p2p)
}

afterEach(() => seed({ ...saved }, { ...p2pSaved }))

afterAll(resetSessionCaches)

const INSTANCE = {
  name: 'Alpha',
  id: 'alpha-id',
  version: '1.2.3',
  api_version: '1.1',
} as RChatState['instance']

const signedIn = (dialog: ActiveDialog, p2pAccount: string | null = 'alice', kept = false) => {
  seed(
    {
      me: me('alice', { display_name: 'Alice A' }),
      guest: false,
      token: 'tok',
      settings: { ...saved.settings, p2p: p2pAccount !== null },
      instance: INSTANCE,
      instanceHost: 'chat.a.test',
      activeDialog: dialog,
    },
    { account: p2pAccount }
  )
  if (kept) localStorage.setItem(alicePeerFlag(), JSON.stringify({ v: 1, on: true }))
  return renderToStaticMarkup(<SettingsMenu />)
}

const guest = (dialog: ActiveDialog) => {
  seed({
    me: null,
    guest: true,
    instance: INSTANCE,
    instanceHost: 'chat.a.test',
    activeDialog: dialog,
  })
  return renderToStaticMarkup(<SettingsMenu />)
}

const entries = (html: string) =>
  [...html.matchAll(/data-settings-section="([a-z0-9]+)"/g)].map(m => m[1])

const current = (html: string) =>
  [...html.matchAll(/data-settings-section="([a-z0-9]+)" aria-current="page"/g)].map(m => m[1])

describe('settings nav', () => {
  test('a signed-in account with P2P on lists every entry, Profile first', () => {
    expect(entries(signedIn({ kind: 'settings' }))).toEqual([
      'profile',
      'general',
      'notifications',
      'privacy',
      'p2p',
      'sync',
      'palette',
      'information',
    ])
  })

  test('a guest has no Privacy or P2P entry', () => {
    expect(entries(guest({ kind: 'settings' }))).toEqual([
      'profile',
      'general',
      'notifications',
      'sync',
      'palette',
      'information',
    ])
  })

  test('the dialog is named Settings and its nav header names the account and instance', () => {
    const html = signedIn({ kind: 'settings' })
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Settings"')
    const nav = html.slice(html.indexOf('data-nav-account'), html.indexOf('data-settings-section'))
    expect(nav).toContain('Alice A')
    expect(nav).toContain('>Alpha</p>')
    expect(nav).toContain('>chat.a.test</p>')
  })

  test('the close button has a title and a label', () => {
    expect(signedIn({ kind: 'settings' })).toContain(
      'title="Close settings" aria-label="Close settings"'
    )
  })
})

describe('where each request to open settings lands', () => {
  const CALLERS: [string, ActiveDialog, string][] = [
    ['the rail gear and the instance tile', { kind: 'settings' }, 'profile'],
    ['Edit profile on the profile card', { kind: 'settings' }, 'profile'],
    ['Add a description on the profile card', { kind: 'settings', focus: 'bio' }, 'profile'],
    ['Change display name', { kind: 'settings', focus: 'display_name' }, 'profile'],
    ['the "settings" id', { kind: 'settings', section: 'settings' }, 'general'],
    ['Settings: General', { kind: 'settings', section: 'general' }, 'general'],
    ['Settings: Notifications', { kind: 'settings', section: 'notifications' }, 'notifications'],
    ['Settings: Privacy', { kind: 'settings', section: 'privacy' }, 'privacy'],
    ['Settings: P2P', { kind: 'settings', section: 'p2p' }, 'p2p'],
    ['P2P storage settings', { kind: 'settings', section: 'p2p', focus: 'p2p_limits' }, 'p2p'],
    ['Settings: Sync config', { kind: 'settings', section: 'sync' }, 'sync'],
    ['Settings: Command palette', { kind: 'settings', section: 'palette' }, 'palette'],
    [
      'a keyboard shortcut in the palette',
      { kind: 'settings', section: 'information' },
      'information',
    ],
  ]
  for (const [who, dialog, want] of CALLERS)
    test(`${who} opens ${want}`, () => {
      expect(current(signedIn(dialog))).toEqual([want])
    })

  test('a guest asking for Privacy gets Profile', () => {
    expect(current(guest({ kind: 'settings', section: 'privacy' }))).toEqual(['profile'])
  })

  test('without P2P the P2P entry is gone and asking for it opens Profile', () => {
    const html = signedIn({ kind: 'settings', section: 'p2p' }, null)
    expect(entries(html)).not.toContain('p2p')
    expect(current(html)).toEqual(['profile'])
  })
})

describe('Settings: P2P in the palette', () => {
  beforeAll(registerAppActions)

  const listed = () =>
    paletteCommands(paletteCtx(useStore.getState())).some(r => r.id === 'settings_p2p')

  const STATES: [string, () => string, boolean][] = [
    ['P2P on for the account', () => signedIn({ kind: 'settings' }), true],
    [
      "the instance's P2P off with the account's P2P data on this device",
      () => signedIn({ kind: 'settings' }, null, true),
      true,
    ],
    ['P2P never turned on', () => signedIn({ kind: 'settings' }, null), false],
    ['a guest', () => guest({ kind: 'settings' }), false],
  ]
  for (const [state, open, shown] of STATES)
    test(`${state}: listed exactly when the nav has the P2P entry`, () => {
      const nav = entries(open()).includes('p2p')
      expect(nav).toBe(shown)
      expect(listed()).toBe(nav)
    })

  test('running it opens the P2P entry', async () => {
    signedIn({ kind: 'settings', section: 'general' })
    expect(await runAction('settings_p2p', paletteCtx(useStore.getState()))).toBe(true)
    expect(useStore.getState().activeDialog).toEqual({ kind: 'settings', section: 'p2p' })
    Object.assign(initial, { activeDialog: useStore.getState().activeDialog })
    expect(current(renderToStaticMarkup(<SettingsMenu />))).toEqual(['p2p'])
  })
})

describe('Profile', () => {
  test('shows the account card, the profile fields, sign-in and the instance', () => {
    const html = signedIn({ kind: 'settings' })
    const card = html.slice(html.indexOf('data-account-card'), html.indexOf('Your profile'))
    expect(card).toContain('Alice A')
    expect(card).toContain('@alice')
    expect(card).toContain('Alpha')
    expect(card).toContain('chat.a.test')
    expect(html).toContain('Your profile')
    expect(html).toContain('Change password')
    expect(html).toContain('Log out')
    expect(html).toContain('About <span class="streamer">Alpha</span>')
    expect(html).toContain('alpha-id')
  })

  test('for a guest shows the guest, no profile fields or password, and the instance', () => {
    const html = guest({ kind: 'settings' })
    expect(html).toContain('Guest')
    expect(html).not.toContain('Your profile')
    expect(html).not.toContain('Change password')
    expect(html).toContain('Exit guest mode')
    expect(html).toContain('alpha-id')
  })

  test('General holds the device and chat settings, not the account', () => {
    const html = signedIn({ kind: 'settings', section: 'general' })
    expect(html).toContain('Typing indicators')
    expect(html).toContain('Light theme')
    expect(html).toContain('Streamer mode')
    expect(html).not.toContain('Your profile')
    expect(html).not.toContain('Instance ID')
  })
})
