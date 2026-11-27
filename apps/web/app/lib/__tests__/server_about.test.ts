import { describe, expect, test } from 'bun:test'
import {
  ABOUT_MAX,
  NO_ABOUT,
  aboutChange,
  aboutError,
  aboutText,
  hostedAbout,
  hostedAboutPatch,
  iconKind,
  p2pAbout,
  p2pAboutContent,
} from '../server_about'
import { iconLook } from '../server_icon'
import { contrast } from '../server_colors'

describe('server about', () => {
  test('a description is cleaned like a bio and cut at the limit', () => {
    expect(aboutText('  Hello\u0007\n\n\n\nworld  ')).toBe('Hello\n\nworld')
    expect(aboutText('   ')).toBeNull()
    expect(aboutText(42)).toBeNull()
    const long = '\u{1F600}'.repeat(ABOUT_MAX + 5)
    expect(Array.from(aboutText(long)!).length).toBe(ABOUT_MAX)
    expect(aboutError('x'.repeat(ABOUT_MAX))).toBeNull()
    expect(aboutError('x'.repeat(ABOUT_MAX + 1))).toBe('Description must be at most 300 characters')
  })

  test('only the two icon kinds are read, anything else is the letter', () => {
    expect(iconKind('identicon')).toBe('identicon')
    expect(iconKind('letter')).toBe('letter')
    expect(iconKind('Identicon')).toBe('letter')
    expect(iconKind(undefined)).toBe('letter')
  })

  test('hosted and P2P servers read to the same about', () => {
    expect(hostedAbout({ description: 'Hi', icon_kind: 'identicon' })).toEqual({
      text: 'Hi',
      icon: 'identicon',
    })
    expect(hostedAbout({})).toEqual(NO_ABOUT)
    expect(p2pAbout({ text: 'Hi', icon: 'identicon', extra: 1 })).toEqual({
      text: 'Hi',
      icon: 'identicon',
    })
    expect(p2pAbout(null)).toEqual(NO_ABOUT)
    expect(p2pAbout(['text'])).toEqual(NO_ABOUT)
    expect(p2pAbout({ text: 7, icon: 'square' })).toEqual(NO_ABOUT)
  })

  test('a save changes only what differs, and blank clears the description', () => {
    const saved = { text: 'Hi', icon: 'letter' as const }
    expect(aboutChange(saved, ' Hi ', 'letter')).toBeNull()
    expect(aboutChange(saved, 'Hey', 'letter')).toEqual({ text: 'Hey' })
    expect(aboutChange(saved, '  ', 'identicon')).toEqual({ text: null, icon: 'identicon' })
    expect(hostedAboutPatch({ text: null, icon: 'identicon' })).toEqual({
      description: null,
      icon_kind: 'identicon',
    })
    expect(hostedAboutPatch({ icon: 'letter' })).toEqual({ icon_kind: 'letter' })
  })

  test('a P2P write keeps the fields it does not know', () => {
    const current = { text: 'Old', icon: 'letter', banner: 'kept' }
    expect(p2pAboutContent(current, { icon: 'identicon' })).toEqual({
      text: 'Old',
      icon: 'identicon',
      banner: 'kept',
    })
    expect(p2pAboutContent(current, { text: null })).toEqual({ icon: 'letter', banner: 'kept' })
    expect(p2pAboutContent(null, { text: ' New\n\n\n\nline ' })).toEqual({ text: 'New\n\nline' })
    const long = 'y'.repeat(ABOUT_MAX + 9)
    expect((p2pAboutContent(null, { text: long }).text as string).length).toBe(ABOUT_MAX)
  })

  test('an icon on a server color gets readable ink, without one it keeps the theme', () => {
    expect(iconLook('letter', 'club', null)).toEqual({ bg: null, fg: null })
    expect(iconLook('letter', 'club', 'nope')).toEqual({ bg: null, fg: null })
    for (const bg of ['#000000', '#FFFFFF', '#6750a4', '#ffd700']) {
      for (const kind of ['letter', 'identicon'] as const) {
        const look = iconLook(kind, 'club', bg)
        expect(look.bg).toBe(bg.toLowerCase())
        expect(contrast(look.bg!, look.fg!)).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
