import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileCard, type FileCardProps } from '../../components/file_card'
import { MarkdownMessage, MediaAttachment, P2pFile } from '../../components/markdown_message'
import { AttachmentList, TileView } from '../../components/p2p/p2p_files'
import { ctxFor } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { menuItems } from '../actions/menu'
import { client } from '../client/client'
import { P2pProvider } from '../client/p2p_react'
import { AccountProvider } from '../client/react'
import { cardMenu, fileTarget } from '../file_card'
import type { FileView } from '../p2p/app'
import type { Attachment } from '../p2p/content'
import { resetSessionCaches, useStore } from '../store'
import { media, msg, user } from './fixtures'
import { createPeerFixture } from './peer_fixture'
import { testAccount } from './test_account'

const initial = useStore.getInitialState()
const saved = { ...initial }
beforeAll(registerAppActions)
afterEach(() => void Object.assign(initial, saved))
afterAll(resetSessionCaches)

// The element a component returns, called inside a host so its hooks run.
const returned = (render: () => ReactNode) => {
  const box: { el?: ReactNode } = {}
  function Host() {
    box.el = render()
    return null
  }
  renderToStaticMarkup(<Host />)
  return box.el as ReactElement<FileCardProps>
}

// The rows of the menu a card gets from its caller's props.
const rowsOf = (el: ReactElement<FileCardProps>) => {
  expect(el.type).toBe(FileCard)
  const menu = cardMenu(el.props.name, el.props)
  const ctx = ctxFor(
    useStore.getState(),
    fileTarget(() => menu),
    'menu'
  )
  return menuItems(ctx).map(i => i.label)
}

describe('a hosted file card', () => {
  const file = media({ id: 'f1', filename: 'report.pdf', mime: 'application/pdf', size: 2048 })

  test("gives its menu the file's full address, to copy", () => {
    const el = returned(() => MediaAttachment({ media: file, own: false, postedAt: 0 }))
    const acct = client.shown()
    const link = new URL(acct.api.mediaUrl('f1'), acct.shareOrigin).href
    expect(el.props.menu.link).toBe(link)
    expect(link.startsWith('http')).toBe(true)
    expect(rowsOf(el)).toEqual(['Download', 'Copy link', 'Copy file name'])
  })
})

describe('a P2P file in a hosted message', () => {
  const sha256 = 'ab'.repeat(32)
  const p2p = (over: Parameters<typeof media>[0] = {}) =>
    media({
      id: 'p1',
      kind: 'p2p',
      hoster: 'bob',
      filename: 'photo.png',
      mime: 'image/png',
      size: 2048,
      sha256,
      ...over,
    })
  const online = () =>
    Object.assign(initial, {
      me: null,
      settings: { ...initial.settings, p2p_attachments: true, asset_previews: true },
      p2pAvailability: { bob: { online: true, ids: ['p1'] } },
    })

  test('online, it is a card with its button on and its other buttons beside it', () => {
    online()
    const html = renderToStaticMarkup(
      <MarkdownMessage message={msg(21, { author: user('bob'), media: p2p() })} />
    )
    expect(html).toContain('data-file-card="" class="mt-1 w-md max-w-full min-w-0"')
    expect(html).toContain('lucide-file-image')
    expect(html).toContain('title="Download photo.png from bob&#x27;s browser"')
    expect(html.includes('disabled=""')).toBe(false)
    expect(html).toContain('title="Show image (connects to the sender)" aria-label="Show image"')
    expect(html).toContain('2 KB')
    expect(html).toContain('>P2P<')
  })

  test('its menu has no link, and the buttons beside Download follow it', () => {
    online()
    const el = returned(() => P2pFile({ media: p2p(), messageId: 22 }))
    expect(el.props.menu.link).toBeNull()
    expect(rowsOf(el)).toEqual(['Download', 'Show image', 'Copy file name'])
    const song = returned(() =>
      P2pFile({ media: p2p({ filename: 'song.mp3', mime: 'audio/mpeg' }), messageId: 24 })
    )
    expect(rowsOf(song)).toEqual(['Download', 'Play audio', 'Copy file name'])
  })

  test('fetched audio is a card with the player inside', () => {
    online()
    client.shown().files.keepPreview(23, { url: 'blob:song', kind: 'audio' })
    const html = renderToStaticMarkup(
      <MarkdownMessage
        message={msg(23, {
          author: user('bob'),
          media: p2p({ filename: 'song.mp3', mime: 'audio/mpeg' }),
        })}
      />
    )
    const card = html.indexOf('data-file-card=""')
    expect(card).toBeGreaterThan(-1)
    expect(html.indexOf('<audio src="blob:song" controls="" class="mt-3 w-full"></audio>')).toBe(
      html.indexOf('<audio', card)
    )
    expect(html).toContain('lucide-file-headphone')
    expect(html).toContain('aria-label="Download song.mp3"')
    expect(html.includes('aria-label="Play audio"')).toBe(false)
  })
})

describe('a P2P room or DM file', () => {
  const att: Attachment = {
    h: 'h1',
    size: 864_051,
    blocks: 1,
    name: 'Mandy Save.zip',
    mime: 'application/zip',
  }
  const view = (over: Partial<FileView> = {}): FileView => ({
    state: 'none',
    got: 0,
    total: 0,
    holders: 2,
    type: null,
    error: null,
    own: false,
    paused: null,
    ...over,
  })
  const props = (v: FileView | undefined, over: Partial<Parameters<typeof TileView>[0]> = {}) => ({
    att,
    canFetch: true,
    own: false,
    v,
    url: null,
    thumb: null,
    save: () => {},
    get: () => {},
    cancel: () => {},
    ...over,
  })
  const tile = (v: FileView | undefined, over: Partial<Parameters<typeof TileView>[0]> = {}) =>
    renderToStaticMarkup(<TileView {...props(v, over)} />)

  test('is a dashed card that says who has it, with its button on and no expiry', () => {
    const html = tile(view())
    expect(html).toContain('data-p2p-file="h1" data-state="none" data-file-card=""')
    expect(html).toContain('border-dashed border-tertiary/60')
    expect(html).toContain('aria-label="Download Mandy Save.zip"')
    expect(html.includes('disabled=""')).toBe(false)
    expect(html).toContain('data-file-status="true" class="mt-2 text-xs text-on-surface-variant"')
    expect(html).toContain('Available from 2 online members')
    expect(html).toContain('844 KB')
    expect(html.includes('Expires')).toBe(false)
    const el = returned(() => TileView(props(view())))
    expect(el.props.menu.link).toBeNull()
    expect(rowsOf(el)).toEqual(['Download', 'Copy file name'])
  })

  test('while it downloads, the status line gives way to the progress and Cancel', () => {
    const v = view({ state: 'downloading', got: 42, total: 100 })
    const html = tile(v)
    expect(html).toContain('data-state="downloading"')
    expect(html).toContain('Downloading 42%')
    expect(html).toContain('aria-label="Cancel download"')
    expect(html.includes('data-file-status')).toBe(false)
    expect(rowsOf(returned(() => TileView(props(v))))).toEqual([
      'Cancel download',
      'Copy file name',
    ])
  })

  test('when nobody online has it, the button is off and the menu has no Download', () => {
    const v = view({ holders: 0 })
    const html = tile(v)
    expect(html).toContain('disabled=""')
    expect(html).toContain('Unavailable right now: nobody who has this file is online')
    const el = returned(() => TileView(props(v)))
    expect(el.props.menu).toEqual({ download: null, link: null })
    expect(rowsOf(el)).toEqual(['Copy file name'])
  })

  test('once on the device it is saved from the card and its menu', () => {
    const v = view({ state: 'done', type: 'application/zip' })
    const html = tile(v)
    expect(html).toContain('data-state="done"')
    expect(html).toContain('aria-label="Save Mandy Save.zip"')
    expect(html).toContain('Stored on this device')
    expect(html.includes('data-file-status')).toBe(false)
    expect(rowsOf(returned(() => TileView(props(v))))).toEqual(['Save', 'Copy file name'])
  })

  test('stored audio is a card with the player inside', () => {
    const song = { ...att, name: 'song.mp3', mime: 'audio/mpeg', dur: 83_000 }
    const html = tile(view({ state: 'done', type: 'audio/mpeg' }), { att: song, url: 'blob:song' })
    expect(html).toContain('data-p2p-file="h1" data-file-card=""')
    expect(html.includes('data-state')).toBe(false)
    expect(html).toContain('border-dashed')
    expect(html).toContain('<audio src="blob:song" controls="" class="mt-3 w-full"></audio>')
    expect(html).toContain('844 KB · 1:23')
    expect(html).toContain('aria-label="Save song.mp3"')
    expect(html).toContain('lucide-file-headphone')
  })

  test("shows the state its identity's store holds", () => {
    const account = testAccount('sam', 'https://files.test')
    try {
      const app = createPeerFixture(account, 'sam')
      Object.assign(app.useP2p.getInitialState(), {
        files: { h1: view({ state: 'downloading', got: 1, total: 4 }) },
      })
      const html = renderToStaticMarkup(
        <AccountProvider session={account}>
          <P2pProvider identity={app}>
            <AttachmentList att={[att]} canFetch />
          </P2pProvider>
        </AccountProvider>
      )
      expect(html).toContain('data-p2p-file="h1" data-state="downloading"')
      expect(html).toContain('Downloading 25%')
    } finally {
      account.store.dispose()
    }
  })
})
