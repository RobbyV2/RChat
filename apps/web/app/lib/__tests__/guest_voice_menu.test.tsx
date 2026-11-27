import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ctxFor, paletteCtx } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { guestVoiceMenuActions } from '../actions/guest_voice'
import { isActionMenu, menuItems } from '../actions/menu'
import { paletteCommands } from '../actions/palette'
import { resetSessionCaches, useStore, type ContextMenuItem } from '../store'
import type { RChatState } from '../store_types'
import { Perm } from '../types'
import { useGuestMenu, useGuestMenuOpen } from '../../components/guest_voice_menu'
import { drain, me, member, paged, role, serverDetail } from './fixtures'
import { Secret } from '../secret'

// Server rendering reads the store's initial state, and a menu reads the current one, so the
// test state goes into both.
const initial = useStore.getInitialState()
const saved = { ...initial }
const current = useStore.getState()

const put = (state: Partial<RChatState>) => {
  Object.assign(initial, state)
  useStore.setState(state)
}

beforeAll(registerAppActions)

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState(current, true)
  resetSessionCaches()
})

const GUEST = '@guest:3f9a1c2b00000000'

// Alice in the server `s`; her role carries `perms`. `hushed`: the guest is muted for everyone
// in voice channel 3.
const staff = (perms: number, hushed = false, over: Partial<RChatState> = {}) =>
  put({
    token: Secret.of('tok'),
    guest: false,
    me: me('alice', {
      servers: [{ name: 's', display_name: 'Space', creator: null, is_admin: false }],
    }),
    servers: { s: serverDetail('s', { roles: [role(1, '#f00', perms)] }) },
    members: { s: paged([member('alice', { role_ids: [1] })]) },
    voiceHushed: hushed ? { 3: [GUEST] } : {},
    contextMenu: null,
    ...over,
  })

// Opens the menu of `name` in the voice of `server` at (120, 80), as a tile or a row does.
function Opened({ server, name }: { server: string | null; name: string }) {
  const menu = useGuestMenu(server, name)
  menu?.(120, 80)
  return <i data-menu={menu !== null} data-open={useGuestMenuOpen(name)} />
}

const open = (server: string | null = 's', name = GUEST) => {
  const html = renderToStaticMarkup(<Opened server={server} name={name} />)
  return { has: html.includes('data-menu="true"'), menu: useStore.getState().contextMenu }
}

const shape = (i: ContextMenuItem) => [
  i.label,
  i.icon ?? null,
  i.subtitle ?? null,
  !!i.wrap,
  !!i.danger,
  !!i.disabled,
  i.submenu?.length ?? 0,
]

const MUTE = ['Mute for everyone', MicOff, 'Stays muted for up to 24 hours', true, false, false, 0]
const UNMUTE = ['Unmute for everyone', Mic, null, false, false, false, 0]
const DISCONNECT = [
  'Disconnect',
  PhoneOff,
  "Can't rejoin voice here for 10 minutes",
  true,
  true,
  false,
  0,
]

const rows = () => open().menu?.items.map(shape)

describe("staff's menu of a guest in voice", () => {
  test('lists what the permissions allow: mute or unmute, then disconnect', () => {
    staff(Perm.TimeoutMembers)
    expect(rows()).toEqual([MUTE])
    staff(Perm.TimeoutMembers, true)
    expect(rows()).toEqual([UNMUTE])
    staff(Perm.Kick)
    expect(rows()).toEqual([DISCONNECT])
    staff(Perm.Kick, true)
    expect(rows()).toEqual([DISCONNECT])
    staff(Perm.TimeoutMembers | Perm.Kick)
    expect(rows()).toEqual([MUTE, DISCONNECT])
    staff(Perm.TimeoutMembers | Perm.Kick, true)
    expect(rows()).toEqual([UNMUTE, DISCONNECT])
    staff(0, false, { me: me('alice', { is_site_admin: true }) })
    expect(rows()).toEqual([MUTE, DISCONNECT])
  })

  test('is only for guests, in a server, for someone with a permission', () => {
    staff(Perm.TimeoutMembers | Perm.Kick)
    expect(open('s', 'bob')).toEqual({ has: false, menu: null })
    expect(open(null)).toEqual({ has: false, menu: null })
    staff(0)
    expect(open()).toEqual({ has: false, menu: null })
    staff(Perm.ManageChannels | Perm.DeleteMessages)
    expect(open()).toEqual({ has: false, menu: null })
    put({ token: null, me: null, guest: true })
    expect(open()).toEqual({ has: false, menu: null })
  })

  test('an account in voice never works out the guest menu', () => {
    staff(Perm.TimeoutMembers | Perm.Kick)
    const real = guestVoiceMenuActions.map(a => a.available)
    let asked = 0
    guestVoiceMenuActions.forEach((a, at) => {
      a.available = ctx => {
        asked += 1
        return real[at](ctx)
      }
    })
    try {
      expect(open('s', 'bob')).toEqual({ has: false, menu: null })
      expect(open(null, 'bob')).toEqual({ has: false, menu: null })
      expect(asked).toBe(0)
      expect(open().has).toBe(true)
      expect(asked).toBeGreaterThan(0)
    } finally {
      guestVoiceMenuActions.forEach((a, at) => (a.available = real[at]))
    }
  })

  test('opens where asked, under the guest label, named for that guest', () => {
    staff(Perm.Kick)
    const { has, menu } = open()
    expect(has).toBe(true)
    expect(menu && [menu.x, menu.y, menu.owner]).toEqual([120, 80, `guest-voice:${GUEST}`])
    expect(renderToStaticMarkup(menu?.header as ReactElement)).toBe(
      '<span class="text-sm font-medium text-on-surface">Guest 3f9a</span>'
    )
    const shown = (name: string) =>
      renderToStaticMarkup(<Opened server={null} name={name} />).includes('data-open="true"')
    Object.assign(initial, { contextMenu: menu })
    expect([shown(GUEST), shown('@guest:0000000000000000')]).toEqual([true, false])
  })

  test('its rows mute, unmute and disconnect that guest in that server', async () => {
    const calls: unknown[][] = []
    const spies = {
      muteGuest: async (...a: unknown[]) => void calls.push(['mute', ...a]),
      disconnectGuest: async (...a: unknown[]) => void calls.push(['disconnect', ...a]),
    } as Partial<RChatState>
    const run = async (hushed: boolean) => {
      staff(Perm.TimeoutMembers | Perm.Kick, hushed, spies)
      for (const item of open().menu?.items ?? []) {
        item.action?.()
        await drain()
      }
    }
    await run(false)
    await run(true)
    expect(calls).toEqual([
      ['mute', 's', GUEST, true],
      ['disconnect', 's', GUEST],
      ['mute', 's', GUEST, false],
      ['disconnect', 's', GUEST],
    ])
  })

  test('is the registry menu of the guest, and its rows stay out of the palette', () => {
    staff(Perm.TimeoutMembers | Perm.Kick)
    expect(isActionMenu(open().menu)).toBe(true)
    const rows = (name: string) =>
      menuItems(
        ctxFor(useStore.getState(), { kind: 'voice_guest', server: 's', name }, 'menu')
      ).map(shape)
    expect(rows(GUEST)).toEqual([MUTE, DISCONNECT])
    expect(rows('bob')).toEqual([])
    const palette = paletteCommands(paletteCtx(useStore.getState())).map(c => c.id)
    expect(palette.length).toBeGreaterThan(20)
    expect(palette.filter(id => id.startsWith('voice_guest_'))).toEqual([])
  })

  test('a row whose guest was muted meanwhile does nothing and says so', async () => {
    const calls: unknown[][] = []
    staff(Perm.TimeoutMembers, false, {
      muteGuest: async (...a: unknown[]) => void calls.push(['mute', ...a]),
      showToast: (...a: unknown[]) => void calls.push(['toast', ...a]),
    } as Partial<RChatState>)
    const [mute] = open().menu?.items ?? []
    put({ voiceHushed: { 3: [GUEST] } })
    mute.action?.()
    await drain()
    expect(calls).toEqual([['toast', "That's no longer available"]])
  })
})
