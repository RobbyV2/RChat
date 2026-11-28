import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement, ReactNode } from 'react'
import { MarkdownMessage, MediaAttachment, P2pFile } from '../../components/markdown_message'
import {
  LightboxView,
  MediaLightbox,
  ViewableImage,
  type LightboxItem,
  type LightboxScope,
  type LightboxShelf,
} from '../../components/media_lightbox'
import { TileView } from '../../components/p2p/p2p_files'
import { registerAppActions } from '../actions/index'
import { client } from '../client/client'
import type { FileMenu } from '../file_card'
import { createShelf } from '../media_lightbox'
import type { MediaMode } from '../media_src'
import type { FileView } from '../p2p/app'
import type { Attachment } from '../p2p/content'
import { setSharing, sharing } from '../platform'
import { resetMasking, setMasking } from '../profanity'
import { useStore } from '../store'
import { me, media, msg, user } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }
const realSharing = sharing()
beforeAll(registerAppActions)
beforeEach(() =>
  setSharing({ ...realSharing, canCopyImage: () => true, canOpenOriginal: () => true })
)
afterEach(() => {
  Object.assign(initial, saved)
  setSharing(realSharing)
})

// The element a component returns, called inside a host so its hooks run.
const returned = (render: () => ReactNode) => {
  const box: { el?: ReactNode } = {}
  function Host() {
    box.el = render()
    return null
  }
  renderToStaticMarkup(<Host />)
  return box.el as ReactElement<{ item?: LightboxItem; children?: ReactNode }>
}

// Whether an element tree has the one component that puts images in the viewer.
const viewable = (el: ReactNode): boolean => {
  if (!el || typeof el !== 'object') return false
  if (Array.isArray(el)) return el.some(viewable)
  const e = el as ReactElement<{ children?: ReactNode }>
  return e.type === ViewableImage || viewable(e.props?.children)
}

const files = client.shown().media
const realMode = files.mediaModeFor
beforeEach(() => {
  files.mediaModeFor = (): MediaMode => 'url'
})
afterEach(() => {
  files.mediaModeFor = realMode
})

const previews = () =>
  Object.assign(initial, {
    me: null,
    settings: {
      ...initial.settings,
      asset_previews: true,
      asset_uploads: true,
      p2p_attachments: true,
    },
  })

describe('images in messages', () => {
  test("a hosted image's description is its alt and its ALT pill", () => {
    previews()
    const html = renderToStaticMarkup(
      <MarkdownMessage
        message={msg(7, { media: media({ id: 'f3', filename: 'pic.png', alt: 'A red door' }) })}
      />
    )
    expect(html).toContain('aria-label="Open pic.png"')
    expect(/<img src="[^"]*\/api\/media\/f3" alt="A red door"/.test(html)).toBe(true)
    expect(html).toContain('aria-label="ALT, image description"')
  })

  test('a hosted image is a button that opens the viewer, not a link to a new tab', () => {
    previews()
    const html = renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { media: media({ id: 'f1', filename: 'pic.png' }) })} />
    )
    expect(html).toContain('data-image-attachment=""')
    expect(html).toContain('<button type="button" aria-label="Open pic.png"')
    expect(/<img src="[^"]*\/api\/media\/f1" alt="pic.png"/.test(html)).toBe(true)
    expect(html.includes('target="_blank"')).toBe(false)
  })

  test('only an image a message shows can enter the viewer', () => {
    previews()
    const hosted = (over: Parameters<typeof media>[0]) =>
      returned(() =>
        MediaAttachment({
          media: media({ id: 'f5', filename: 'pic.png', ...over }),
          own: false,
          postedAt: 0,
          messageId: 5,
        })
      )
    const shown = hosted({})
    expect(viewable(shown)).toBe(true)
    expect(shown.props.item?.src.endsWith('/media/f5')).toBe(true)
    expect(viewable(hosted({ spoiler: true }))).toBe(false)
    expect(viewable(hosted({ removed: true }))).toBe(false)
    expect(viewable(hosted({ filename: 'notes.pdf', mime: 'application/pdf' }))).toBe(false)

    const p2p = (over: Parameters<typeof media>[0], id: number) =>
      returned(() =>
        P2pFile({
          media: media({
            id: 'p5',
            kind: 'p2p',
            hoster: 'bob',
            filename: 'photo.png',
            sha256: 'ab'.repeat(32),
            ...over,
          }),
          messageId: id,
        })
      )
    client.shown().files.keepPreview(51, { url: 'blob:p51', kind: 'image' })
    client.shown().files.keepPreview(52, { url: 'blob:p52', kind: 'image' })
    expect(viewable(p2p({}, 51))).toBe(true)
    expect(viewable(p2p({ spoiler: true }, 52))).toBe(false)
    expect(viewable(p2p({}, 53))).toBe(false)

    const att: Attachment = { h: 'h5', size: 9, blocks: 1, name: 'cat.png', mime: 'image/png' }
    const done: FileView = {
      state: 'done',
      got: 0,
      total: 0,
      holders: 1,
      type: 'image/png',
      error: null,
      own: false,
      paused: null,
    }
    const tile = (over: { att?: Attachment; v?: FileView; url?: string | null }) =>
      returned(() =>
        TileView({
          att,
          canFetch: true,
          own: false,
          message: 'ev5',
          v: done,
          url: 'blob:cat',
          thumb: null,
          save: () => {},
          get: () => {},
          cancel: () => {},
          ...over,
        })
      )
    expect(viewable(tile({}))).toBe(true)
    expect(viewable(tile({ att: { ...att, spoiler: true } }))).toBe(false)
    expect(viewable(tile({ v: { ...done, state: 'none' }, url: null }))).toBe(false)
  })

  test('a hidden spoiler image is a cover, not an image the viewer opens', () => {
    previews()
    const html = renderToStaticMarkup(
      <MarkdownMessage
        message={msg(6, { media: media({ id: 'f2', filename: 'pic.png', spoiler: true }) })}
      />
    )
    expect(html).toContain('aria-label="Spoiler image, press to reveal"')
    expect(html.includes('aria-label="Open pic.png"')).toBe(false)
  })

  test('a fetched P2P image in a hosted message opens the viewer, its description its alt', () => {
    previews()
    client.shown().files.keepPreview(31, { url: 'blob:pic', kind: 'image' })
    const html = renderToStaticMarkup(
      <MarkdownMessage
        message={msg(31, {
          author: user('bob'),
          media: media({
            id: 'p1',
            kind: 'p2p',
            hoster: 'bob',
            filename: 'photo.png',
            sha256: 'ab'.repeat(32),
            alt: 'Two cups of tea',
          }),
        })}
      />
    )
    expect(html).toContain('aria-label="Open photo.png"')
    expect(html).toContain('<img src="blob:pic" alt="Two cups of tea"')
    expect(html).toContain('aria-label="ALT, image description"')
  })

  test('a stored P2P room or DM image opens the viewer, its cleaned description its alt', () => {
    const view: FileView = {
      state: 'done',
      got: 0,
      total: 0,
      holders: 1,
      type: 'image/png',
      error: null,
      own: false,
      paused: null,
    }
    const html = renderToStaticMarkup(
      <TileView
        att={{
          h: 'h1',
          size: 2048,
          blocks: 1,
          name: 'cat.png',
          mime: 'image/png',
          w: 64,
          h_px: 48,
        }}
        canFetch
        own={false}
        message="ev1"
        v={view}
        url="blob:cat"
        thumb={null}
        save={() => {}}
        get={() => {}}
        cancel={() => {}}
      />
    )
    expect(html).toContain('data-p2p-file="h1" data-image-attachment=""')
    expect(html).toContain('aria-label="Open cat.png"')
    expect(html).toContain('<img src="blob:cat" alt="cat.png" width="64" height="48"')
    expect(html.includes('data-alt-badge')).toBe(false)
    const described = renderToStaticMarkup(
      <TileView
        att={{
          h: 'h2',
          size: 2048,
          blocks: 1,
          name: 'dog.png',
          mime: 'image/png',
          alt: '  A dog\u0007 asleep  ',
        }}
        canFetch
        own={false}
        message="ev2"
        v={view}
        url="blob:dog"
        thumb={null}
        save={() => {}}
        get={() => {}}
        cancel={() => {}}
      />
    )
    expect(described).toContain('aria-label="Open dog.png"')
    expect(described).toContain('<img src="blob:dog" alt="A dog asleep"')
    expect(described).toContain('aria-label="ALT, image description"')
  })
})

describe('the viewer', () => {
  const item = (over: Partial<LightboxItem> = {}): LightboxItem => ({
    src: 'blob:one',
    name: 'one.png',
    own: false,
    fileMask: true,
    size: 2048,
    alt: null,
    ...over,
  })
  const menuOf = (over: Partial<FileMenu> = {}): FileMenu => ({
    name: 'one.png',
    verb: 'Download',
    download: () => {},
    cancel: null,
    extra: [],
    link: 'https://chat.example/api/media/f1',
    remove: null,
    ...over,
  })

  // A gallery of `items` open at `at`, in a list whose Forward is `forward`.
  const render = (
    items: { item: LightboxItem; menu: FileMenu }[],
    at: number,
    forward: LightboxScope['forward'] = () => () => {}
  ) => {
    const shelf: LightboxShelf = createShelf()
    const scope: LightboxScope = {
      rows: () => ({
        ids: items.map((_, i) => i),
        places: items.map((_, i) => ({ first: i === 0, last: i === items.length - 1 })),
      }),
      forward,
      subscribe: () => () => {},
      version: () => 0,
    }
    items.forEach(({ item, menu }, i) =>
      shelf.put({
        key: `k${i}`,
        message: i,
        index: 0,
        scope,
        item,
        act: () => ({ menu, button: () => null, bytes: null }),
      })
    )
    shelf.show(`k${at}`)
    const open = shelf.state()!
    const entry = shelf.entry(open.keys[open.at])!
    return renderToStaticMarkup(<LightboxView shelf={shelf} open={open} entry={entry} />)
  }
  const one = (over: Partial<LightboxItem> = {}, menu: Partial<FileMenu> = {}) => ({
    item: item(over),
    menu: menuOf(menu),
  })
  const labels = (html: string) =>
    [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(m => m[1])

  test('is a modal dialog, so the list and panels under it leave Escape to it', () => {
    const html = render([one()], 0)
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Image viewer"')
  })

  test('its bar has every action, each icon with a title and a label', () => {
    const html = render([one({ name: 'a.png' }), one(), one({ name: 'c.png' })], 1)
    expect(new Set(labels(html))).toEqual(
      new Set([
        'Close',
        'Open original',
        'Copy link',
        'Download',
        'Rotate left',
        'Rotate right',
        'Reset view',
        'Zoom in',
        'Zoom out',
        'Forward',
        'More options',
        'Previous image',
        'Next image',
      ])
    )
    expect(labels(html).includes('Star')).toBe(false)
    for (const tag of html.match(/<button[^>]*>/g) ?? []) {
      expect(tag).toContain('title="')
      expect(tag).toContain('aria-label="')
    }
    expect(html).toContain('title="Download one.png"')
  })

  test('its bar reads where it is, the name and the file size, with no zoom before it loads', () => {
    const html = render([one({ name: 'a.png' }), one(), one({ name: 'c.png' })], 1)
    expect(html).toContain('2 / 3')
    expect(html).toContain('one.png')
    expect(html).toContain('<span class="shrink-0">2 KB</span>')
    expect(html.includes('100%')).toBe(false)
    expect(html).toContain('<img src="blob:one" alt="one.png"')
  })

  test('what it announces is where it is and the name, never the zoom', () => {
    const html = render([one(), one()], 0)
    const live = [
      /<p aria-live="polite"[^>]*>(.*?)<\/p>/.exec(html)?.[1],
      /<span aria-live="polite"[^>]*>(.*?)<\/span><\/span>/.exec(html)?.[1],
    ].filter(t => t !== undefined)
    expect(live.length).toBe(2)
    for (const text of live) {
      expect(text).toContain('one.png')
      expect(text.includes('%')).toBe(false)
    }
  })

  test('it sits under menus, confirms and the call banner, over dialogs and drawers', () => {
    const html = render([one()], 0)
    expect(html).toContain('fixed inset-x-0 top-app z-lightbox')
    expect(html.includes('z-50')).toBe(false)
  })

  test('Open original shows only where the platform opens the address', () => {
    setSharing({ ...realSharing, canOpenOriginal: () => false })
    const off = labels(render([one()], 0))
    expect(off.includes('Open original')).toBe(false)
    expect(off).toContain('More options')
    setSharing({ ...realSharing, canOpenOriginal: src => src !== 'blob:one' })
    expect(labels(render([one()], 0)).includes('Open original')).toBe(false)
    expect(labels(render([one({ src: 'https://chat.example/a.png' })], 0))).toContain(
      'Open original'
    )
  })

  test('Copy image waits until the image shows', () => {
    expect(labels(render([one()], 0)).includes('Copy image')).toBe(false)
  })

  test('a download running shows Cancel in the place of Download', () => {
    const running = labels(render([one({}, { download: null, cancel: () => {} })], 0))
    expect(running).toContain('Cancel download')
    expect(running.includes('Download')).toBe(false)
    expect(labels(render([one()], 0)).includes('Cancel download')).toBe(false)
  })

  test('while the image loads it shows its preview, or a placeholder without one', () => {
    const plain = render([one()], 0)
    expect(plain).toContain('role="status" aria-label="Loading image"')
    const preview = render([one({ placeholder: 'blob:thumb' })], 0)
    expect(preview).toContain('<img src="blob:thumb" alt=""')
  })

  describe('with the display filter on', () => {
    const readings = {
      text: (t: string) => t.replace(/cun\.ts/g, '***.**'),
      file: (t: string) => t.replace(/fuck/g, '****'),
    }
    beforeEach(async () => {
      await setMasking(true, () => Promise.resolve(readings))
      Object.assign(initial, { profanityOn: true, profanityReady: true, me: me('alice') })
    })
    afterEach(() => {
      resetMasking()
      Object.assign(initial, { profanityOn: false, profanityReady: false, me: null })
    })

    test('a hosted name reads as a file name, a P2P name and every description as text', () => {
      const hosted = render([one({ name: 'cun.ts' })], 0)
      expect(hosted).toContain('title="cun.ts"')
      const p2p = render([one({ name: 'cun.ts', fileMask: false })], 0)
      expect(p2p).toContain('title="***.**"')
      expect(p2p.includes('title="cun.ts"')).toBe(false)
      const described = render([one({ alt: 'see cun.ts' })], 0)
      expect(described).toContain('alt="see ***.**"')
      expect(described.includes('see cun.ts')).toBe(false)
    })

    test("an image in a message has its description's alt filtered like its pill", () => {
      previews()
      const html = renderToStaticMarkup(
        <MarkdownMessage
          message={msg(9, {
            author: user('bob'),
            media: media({ id: 'f9', filename: 'pic.png', alt: 'see cun.ts' }),
          })}
        />
      )
      expect(html).toContain('alt="see ***.**"')
    })

    test('your own description is never filtered for you', () => {
      expect(render([one({ alt: 'see cun.ts', own: true })], 0)).toContain('alt="see cun.ts"')
    })
  })

  test('a P2P image has no link to copy, and the arrows stop at the ends', () => {
    const p2p = one({ fileMask: false }, { link: null, verb: 'Save' })
    const first = render([p2p, one()], 0)
    expect(labels(first).includes('Copy link')).toBe(false)
    expect(labels(first).includes('Previous image')).toBe(false)
    expect(labels(first)).toContain('Next image')
    expect(first).toContain('title="Save one.png"')
    const last = render([one(), one()], 1)
    expect(labels(last).includes('Next image')).toBe(false)
    expect(labels(last)).toContain('Previous image')
  })

  test('one image alone has no counter and no arrows', () => {
    const html = render([one()], 0)
    expect(html.includes(' / ')).toBe(false)
    expect(labels(html).some(l => l.endsWith(' image') && l !== 'Copy image')).toBe(false)
  })

  test('Forward shows only where the message may be forwarded', () => {
    expect(labels(render([one()], 0, () => null)).includes('Forward')).toBe(false)
  })

  test('Download is off while no download may start', () => {
    const html = render([one({}, { download: null })], 0)
    expect(/<button[^>]*aria-label="Download"[^>]*aria-disabled="true"/.test(html)).toBe(true)
  })

  test('with animations off the backdrop is a plain scrim, without blur', () => {
    Object.assign(initial, { anim: { on: false, motion: 'device' } })
    const html = render([one()], 0)
    expect(html).toContain('bg-scrim/85')
    expect(html.includes('backdrop-blur')).toBe(false)
    expect(html.includes('animate-lightbox')).toBe(false)
  })

  test('with animations on the app behind blurs and the image zooms in', () => {
    Object.assign(initial, { anim: { on: true, motion: 'always' } })
    const html = render([one()], 0)
    expect(html).toContain('data-lightbox-blur=""')
    expect(html).toContain('backdrop-blur-md')
    expect(html).toContain('animate-lightbox-zoom')
  })

  test("alt text is the image's alt, behind the same ALT pill as in messages", () => {
    const html = render([one({ alt: 'A cat on a mat' })], 0)
    expect(html).toContain('<img src="blob:one" alt="A cat on a mat"')
    const stage = html.slice(html.indexOf('data-lightbox-stage'))
    expect(stage).toContain(
      'title="Image description" aria-label="ALT, image description" aria-expanded="false"'
    )
    const plain = render([one()], 0)
    expect(plain).toContain('<img src="blob:one" alt="one.png"')
    expect(plain.includes('data-alt-badge')).toBe(false)
  })

  test('shows nothing while closed', () => {
    expect(renderToStaticMarkup(<MediaLightbox />)).toBe('')
  })
})
