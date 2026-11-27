import { shownPeer } from './shown_peer'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import SettingsMenu from '../../components/settings_menu'
import { peerStorage } from '../client/keys'
import { paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { paletteCommands } from '../actions/palette'
import { runAction } from '../actions/registry'
import { home } from './home_instance'
import { p2pKey } from '../p2p/app'
import { useStore } from '../store'
import type { ActiveDialog, RChatState } from '../store_types'
import type { P2pState } from '../p2p/app/store'
import { settingsRows, settingsSections, type SettingsSection } from '../settings_sections'
import { me } from './fixtures'
import { Secret } from '../secret'

const alicePeerFlag = () => peerStorage(home, 'alice').scoped(p2pKey('alice'))
const initial = useStore.getInitialState()
const saved = { ...initial }
const p2pInitial = () => shownPeer().useP2p.getInitialState()
const p2pSaved = { ...p2pInitial() }

// A static render reads the initial state through hooks and the current one outside them.
const seed = (state: Partial<RChatState>, p2p: Partial<P2pState> = {}) => {
  localStorage.removeItem(alicePeerFlag())
  Object.assign(initial, state)
  useStore.setState(state)
  if (state.me && !state.guest && state.settings?.p2p !== false) {
    Object.assign(p2pInitial(), p2p)
    shownPeer().useP2p.setState(p2p)
  }
}

afterEach(() => seed({ ...saved }, { ...p2pSaved }))

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
      token: Secret.of('tok'),
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
      'privacy',
      'general',
      'notifications',
      'palette',
      'sync',
      'p2p',
      'information',
    ])
  })

  test('a guest has no Privacy or P2P entry', () => {
    expect(entries(guest({ kind: 'settings' }))).toEqual([
      'profile',
      'general',
      'notifications',
      'palette',
      'sync',
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
    const at = html.indexOf('data-account-card')
    const card = html.slice(at, html.indexOf('Your profile', at))
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

  test('a guest keeps the Animations row', () => {
    expect(guest({ kind: 'settings', section: 'general' })).toContain('aria-label="Animations"')
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
    expect(html).toContain('role="switch" aria-checked="false" aria-label="Animations"')
    expect(html).toContain('title="Animations"')
    expect(html).toContain('aria-label="Motion"')
    expect(html).toContain('Play motion anyway')
    expect(html).not.toContain('so things change without moving')
    expect(html).toContain('Streamer mode')
    expect(html).not.toContain('Your profile')
    expect(html).not.toContain('Instance ID')
  })
})

describe('the settings dialog', () => {
  test('is a large dialog that sits above full pages', () => {
    const html = signedIn({ kind: 'settings' })
    expect(html).toContain('md:w-[min(94vw,1120px)]')
    expect(/^<div class="[^"]*\bz-top\b/.test(html)).toBe(true)
  })

  test('the nav groups its entries under headings', () => {
    const html = signedIn({ kind: 'settings' })
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
    const headings = [...nav.matchAll(/<p class="[^"]*uppercase[^"]*">([^<]+)<\/p>/g)].map(
      m => m[1]
    )
    expect(headings).toEqual(['Your account', 'App settings', 'Peer-to-peer', 'About'])
  })

  test('the nav header has the search field and a way to the profile', () => {
    const html = signedIn({ kind: 'settings', section: 'general' })
    expect(html.indexOf('placeholder="Search settings"')).toBeLessThan(
      html.indexOf('data-nav-account')
    )
    const header = html.slice(html.indexOf('data-nav-account'), html.indexOf('<nav'))
    expect(header).toContain('<p class="streamer truncate text-sm font-medium text-on-surface">')
    expect(header).toContain('Edit your profile')
    const guestHeader = guest({ kind: 'settings' })
    expect(
      guestHeader.slice(guestHeader.indexOf('data-nav-account'), guestHeader.indexOf('<nav'))
    ).not.toContain('Edit your profile')
  })

  test('opened without a section, phones see the list while wide screens show Profile', () => {
    const html = signedIn({ kind: 'settings' })
    expect(html).toContain('data-screen="list"')
    expect(current(html)).toEqual(['profile'])
    expect(signedIn({ kind: 'settings', section: 'privacy' })).toContain('data-screen="section"')
    expect(signedIn({ kind: 'settings', focus: 'bio' })).toContain('data-screen="section"')
  })

  test('the open section lists its parts in the nav', () => {
    const html = signedIn({ kind: 'settings', section: 'privacy' })
    expect([...html.matchAll(/data-settings-part="([a-z_]+)"/g)].map(m => m[1])).toEqual([
      'user_privacy',
      'user_links',
      'user_blocked',
    ])
  })

  const anchored = (open: (dialog: ActiveDialog) => string, sections: SettingsSection[]) => {
    const signed = open === signedIn
    const missing: string[] = []
    for (const section of sections) {
      const html = open({ kind: 'settings', section })
      for (const row of settingsRows(section, { signedIn: signed, desktop: false }))
        if (!html.includes(`id="row-${row.id}"`)) missing.push(`${section}/${row.id}`)
    }
    expect(missing).toEqual([])
  }

  test('every row search finds for an account has its anchor in its section', () => {
    anchored(signedIn, settingsSections({ signedIn: true, p2p: true }))
  })

  test('every row search finds for a guest has its anchor in its section', () => {
    anchored(guest, settingsSections({ signedIn: false, p2p: false }))
  })

  const extraAnchors = (open: (dialog: ActiveDialog) => string, sections: SettingsSection[]) => {
    const signed = open === signedIn
    const extra: string[] = []
    for (const section of sections) {
      const html = open({ kind: 'settings', section })
      const rows = settingsRows(section, { signedIn: signed, desktop: false }).map(r => r.id)
      for (const [, id] of html.matchAll(/id="row-([^"]+)"/g))
        if (!rows.includes(id)) extra.push(`${section}/${id}`)
    }
    return extra
  }

  test('every anchor in a section is a row search finds there', () => {
    expect(extraAnchors(signedIn, settingsSections({ signedIn: true, p2p: true }))).toEqual([])
    expect(extraAnchors(guest, settingsSections({ signedIn: false, p2p: false }))).toEqual([])
  })

  test('the way to the profile is a full size touch target on phones', () => {
    const html = signedIn({ kind: 'settings' })
    const button = /<button[^>]*>(<svg[^>]*>.*?<\/svg>)?Edit your profile/.exec(html)?.[0] ?? ''
    expect(button).toContain('min-h-11')
    expect(button).toContain('md:min-h-0')
  })
})
