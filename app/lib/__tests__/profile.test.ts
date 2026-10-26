import { describe, expect, test } from 'bun:test'
import {
  CARD_GAP,
  CARD_MARGIN,
  bannerColor,
  canEditRoles,
  defaultBanner,
  freeRoles,
  heldRoles,
  hslHex,
  identiconHue,
  placeCard,
  profileActions,
  validColor,
  type ActionInput,
} from '../profile'
import { ALL_PERMS, Perm } from '../types'
import { role, user } from './fixtures'

describe('banner colors', () => {
  test('validColor accepts only #rrggbb', () => {
    expect(validColor('#a1B2c3')).toBe(true)
    for (const bad of ['', '#abc', 'a1b2c3', '#a1b2c', '#a1b2c3d', '#ggggggg', null, undefined])
      expect(validColor(bad)).toBe(false)
  })

  test('hslHex converts known colors', () => {
    expect(hslHex(0, 1, 0.5)).toBe('#ff0000')
    expect(hslHex(120, 1, 0.5)).toBe('#00ff00')
    expect(hslHex(240, 1, 0.25)).toBe('#000080')
    expect(hslHex(0, 0, 1)).toBe('#ffffff')
  })

  test('identicon hue matches minidenticons palette', () => {
    expect(identiconHue('alice')).toBe(280)
    expect(identiconHue('bob')).toBe(0)
    expect(identiconHue('carol')).toBe(40)
    expect(identiconHue('admin')).toBe(200)
    for (const name of ['x', 'Ünïcode😀', 'a'.repeat(200)]) {
      const hue = identiconHue(name)
      expect(hue % 40).toBe(0)
      expect(hue >= 0 && hue < 360).toBe(true)
    }
  })

  test('default banner follows the avatar', () => {
    expect(defaultBanner(user('alice', { avatar_kind: 'color', avatar_color: '#ABCDEF' }))).toBe(
      '#abcdef'
    )
    const identicon = defaultBanner(user('alice'))
    expect(identicon).toBe(hslHex(280, 0.6, 0.42))
    expect(defaultBanner(user('alice'))).toBe(identicon)
    expect(defaultBanner(user('bob'))).toBe(hslHex(0, 0.6, 0.42))
    expect(defaultBanner(user('alice', { avatar_kind: 'color', avatar_color: null }))).toBe(
      identicon
    )
    expect(
      defaultBanner(user('alice', { avatar_kind: 'identicon', avatar_color: '#123456' }))
    ).toBe(identicon)
  })

  test('custom banner wins when valid', () => {
    const u = user('alice', { avatar_kind: 'color', avatar_color: '#111111' })
    expect(bannerColor(u, '#FF00AA')).toBe('#ff00aa')
    expect(bannerColor(u, null)).toBe('#111111')
    expect(bannerColor(u, 'red')).toBe('#111111')
    expect(bannerColor(u, undefined)).toBe('#111111')
  })
})

describe('placeCard', () => {
  const view = { width: 1280, height: 800 }
  const card = { width: 300, height: 400 }

  test('opens to the right of the click', () => {
    expect(placeCard({ x: 100, y: 200 }, card, view)).toEqual({ x: 100 + CARD_GAP, y: 200 })
  })

  test('flips to the left near the right edge', () => {
    expect(placeCard({ x: 1200, y: 200 }, card, view)).toEqual({
      x: 1200 - CARD_GAP - card.width,
      y: 200,
    })
  })

  test('clamps inside a viewport too narrow for either side', () => {
    const narrow = { width: 500, height: 800 }
    expect(placeCard({ x: 250, y: 100 }, card, narrow).x).toBe(
      narrow.width - card.width - CARD_MARGIN
    )
    expect(placeCard({ x: 10, y: 100 }, card, narrow).x).toBe(10 + CARD_GAP)
  })

  test('shifts up near the bottom and down near the top', () => {
    expect(placeCard({ x: 100, y: 700 }, card, view).y).toBe(
      view.height - card.height - CARD_MARGIN
    )
    expect(placeCard({ x: 100, y: -50 }, card, view).y).toBe(CARD_MARGIN)
  })

  test('oversized cards pin to the margins', () => {
    const tiny = { width: 200, height: 300 }
    expect(placeCard({ x: 150, y: 150 }, card, tiny)).toEqual({ x: CARD_MARGIN, y: CARD_MARGIN })
  })

  test('result always stays inside the viewport when the card fits', () => {
    for (let x = -20; x <= 1300; x += 37)
      for (let y = -20; y <= 820; y += 41) {
        const at = placeCard({ x, y }, card, view)
        expect(at.x >= CARD_MARGIN && at.x + card.width <= view.width - CARD_MARGIN).toBe(true)
        expect(at.y >= CARD_MARGIN && at.y + card.height <= view.height - CARD_MARGIN).toBe(true)
      }
  })
})

describe('roles and actions', () => {
  const roles = [role(1, '#ff0000', 0), role(2, '#00ff00', 0), role(3, '#0000ff', 0)]

  test('held roles keep server order, free roles are the rest', () => {
    expect(heldRoles(roles, [3, 1]).map(r => r.id)).toEqual([1, 3])
    expect(freeRoles(roles, [3, 1]).map(r => r.id)).toEqual([2])
    expect(heldRoles(roles, [9])).toEqual([])
  })

  const base: ActionInput = {
    signedIn: true,
    self: false,
    siteAdmin: false,
    inServer: true,
    perms: 0,
    member: { is_admin: false },
    targetPerms: 0,
  }

  test('plain members and guests get no controls', () => {
    expect(profileActions(base)).toEqual([])
    expect(profileActions({ ...base, signedIn: false, perms: ALL_PERMS, siteAdmin: true })).toEqual(
      []
    )
    expect(canEditRoles({ ...base, signedIn: false, perms: ALL_PERMS })).toBe(false)
  })

  test('kick perm allows kick and server ban, never on yourself', () => {
    expect(profileActions({ ...base, perms: Perm.Kick })).toEqual(['kick', 'server_ban'])
    expect(profileActions({ ...base, perms: Perm.Kick, member: null })).toEqual(['server_ban'])
    expect(profileActions({ ...base, perms: Perm.Kick, self: true })).toEqual([])
  })

  test('kick and server ban need strictly more perms than the target', () => {
    const kick = { ...base, perms: Perm.Kick }
    expect(profileActions({ ...kick, targetPerms: Perm.Kick })).toEqual([])
    expect(profileActions({ ...kick, member: { is_admin: true }, targetPerms: ALL_PERMS })).toEqual(
      []
    )
    expect(profileActions({ ...kick, targetPerms: Perm.ManageChannels })).toEqual([])
    const mod = { ...base, perms: Perm.Kick | Perm.ManageAdmins, targetPerms: Perm.Kick }
    expect(profileActions(mod)).toEqual(['kick', 'server_ban', 'promote', 'transfer'])
    const full = { ...base, perms: ALL_PERMS, member: { is_admin: true }, targetPerms: ALL_PERMS }
    expect(profileActions(full)).toEqual(['revoke', 'transfer'])
    expect(profileActions({ ...full, siteAdmin: true })).toEqual([
      'kick',
      'server_ban',
      'revoke',
      'transfer',
      'site_ban',
    ])
  })

  test('manage admins allows promote/revoke and transfer', () => {
    expect(profileActions({ ...base, perms: Perm.ManageAdmins })).toEqual(['promote', 'transfer'])
    expect(
      profileActions({ ...base, perms: Perm.ManageAdmins, member: { is_admin: true } })
    ).toEqual(['revoke', 'transfer'])
    expect(
      profileActions({ ...base, perms: Perm.ManageAdmins, self: true, member: { is_admin: true } })
    ).toEqual(['revoke'])
    expect(profileActions({ ...base, perms: Perm.ManageAdmins, member: null })).toEqual([])
    expect(canEditRoles({ ...base, perms: Perm.ManageAdmins })).toBe(true)
    expect(canEditRoles({ ...base, perms: Perm.ManageAdmins, member: null })).toBe(false)
    expect(canEditRoles({ ...base, perms: Perm.Kick })).toBe(false)
  })

  test('site ban only for site admins, and outside servers only that', () => {
    expect(profileActions({ ...base, siteAdmin: true })).toEqual(['site_ban'])
    expect(profileActions({ ...base, siteAdmin: true, self: true })).toEqual([])
    expect(
      profileActions({ ...base, inServer: false, member: null, perms: ALL_PERMS, siteAdmin: true })
    ).toEqual(['site_ban'])
    expect(canEditRoles({ ...base, inServer: false, member: null, perms: ALL_PERMS })).toBe(false)
  })
})
