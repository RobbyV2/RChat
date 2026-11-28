import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerGlyph } from '../../components/server_rail'
import { b64u } from '../p2p/canonical'
import { parsePic, type PicWire } from '../p2p/pictures'
import { serverIconImage } from '../selectors'
import { p2pAbout, p2pAboutContent } from '../server_about'
import { useStore } from '../store'
import type { RChatState } from '../store_types'

const ID = '0123456789abcdef0123456789abcdef'
const h = (n: number) => b64u(new Uint8Array(32).fill(n))
const wire: PicWire = { s: [h(1), 10], l: [h(2), 20] }

// A static render reads the store's first state.
const first = useStore.getInitialState()
const saved = { settings: first.settings, streamer: first.streamer, avatarMode: first.avatarMode }

afterEach(() => void Object.assign(first, saved))

const showing = (on: boolean, streamer = false) =>
  void Object.assign(first, {
    settings: { ...saved.settings, profile_pictures: on },
    streamer,
    avatarMode: 'pictures',
  })

describe('a hosted server picture', () => {
  const look = { icon_kind: 'letter', icon_image: ID, banner_color: null }

  test('the icon draws first and the picture waits over it, filling the tile', () => {
    showing(true)
    const plain = renderToStaticMarkup(
      <ServerGlyph name="club" displayName="Club" look={{ ...look, icon_image: null }} />
    )
    const html = renderToStaticMarkup(<ServerGlyph name="club" displayName="Club" look={look} />)
    expect(plain).toContain('data-server-icon="letter"')
    expect(html).toContain(plain)
    expect(html).toContain('data-avatar-picture="loading"')
    expect(html).toContain(`/avatars/${ID}/128"`)
    expect(html).toContain('rounded-inherit')
    expect(html).not.toContain('rounded-full')
  })

  test('no picture is asked for where pictures are off, hidden or the site serves none', () => {
    const plain = renderToStaticMarkup(
      <ServerGlyph name="club" displayName="Club" look={{ ...look, icon_image: null }} />
    )
    showing(false)
    expect(renderToStaticMarkup(<ServerGlyph name="club" displayName="Club" look={look} />)).toBe(
      plain
    )
    showing(true, true)
    expect(renderToStaticMarkup(<ServerGlyph name="club" displayName="Club" look={look} />)).toBe(
      plain
    )
    showing(true)
    Object.assign(first, { avatarMode: 'builtin' })
    expect(renderToStaticMarkup(<ServerGlyph name="club" displayName="Club" look={look} />)).toBe(
      plain
    )
  })

  test('the picture of a server comes from its detail, else from the server list', () => {
    const list = { me: { servers: [{ name: 'club', icon_image: ID }] }, servers: {} }
    expect(serverIconImage(list as unknown as RChatState, 'club')).toBe(ID)
    const open = { me: null, servers: { club: { icon_image: null } } }
    expect(serverIconImage(open as unknown as RChatState, 'club')).toBeNull()
    expect(serverIconImage(open as unknown as RChatState, 'other')).toBeNull()
  })
})

describe('a P2P server picture', () => {
  test('the about register carries it beside the text and the icon', () => {
    expect(p2pAbout({ text: 'Hi', icon: 'identicon', pic: wire })).toEqual({
      text: 'Hi',
      icon: 'identicon',
      pic: parsePic(wire),
    })
    expect(p2pAbout({ text: 'Hi', pic: { s: 1 } })).toEqual({ text: 'Hi', icon: 'letter' })
  })

  test('a change sets or removes it and leaves the other fields as they are', () => {
    const current = { text: 'Hi', icon: 'identicon', later: 1 }
    const set = p2pAboutContent(current, { pic: parsePic(wire) })
    expect(set).toEqual({ ...current, pic: wire })
    expect(p2pAboutContent(set, { pic: null })).toEqual(current)
    expect(p2pAboutContent(set, { text: 'New' })).toEqual({ ...set, text: 'New' })
  })
})
