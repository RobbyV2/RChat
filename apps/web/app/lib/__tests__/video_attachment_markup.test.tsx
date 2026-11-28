import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { longPress } from '../../components/context_menu'
import { MarkdownMessage, MediaAttachment, P2pFile } from '../../components/markdown_message'
import { TileView } from '../../components/p2p/p2p_files'
import { Selectable } from '../../components/selection'
import {
  VideoAttachment,
  VideoAttachmentBody,
  VideoPlaceholder,
  type VideoAttachmentProps,
} from '../../components/video_attachment'
import { registerAppActions } from '../actions/index'
import { client } from '../client/client'
import type { MediaMode } from '../media_src'
import { emptySelection } from '../selection'
import { PREVIEW_MAX } from '../sniff'
import { useStore } from '../store'
import { me, media, msg, user } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }
beforeAll(registerAppActions)
afterEach(() => void Object.assign(initial, saved))
afterEach(() => client.shown().media.videoFailures.clear())

// Media loads by address (`url`) or from fetched bytes (`blob`), whatever earlier tests left.
const files = client.shown().media
const realMode = files.mediaModeFor
let mode: MediaMode = 'url'
beforeEach(() => {
  mode = 'url'
  files.mediaModeFor = () => mode
})
afterEach(() => {
  files.mediaModeFor = realMode
})

// The element a component returns, called inside a host so its hooks run.
const returned = <P,>(render: () => ReactNode) => {
  const box: { el?: ReactNode } = {}
  function Host() {
    box.el = render()
    return null
  }
  renderToStaticMarkup(<Host />)
  return box.el as ReactElement<P>
}

// The video a caller returns, inside the box that watches it when there is one.
const videoOf = (render: () => ReactNode) => {
  const el = returned<VideoAttachmentProps & { children?: ReactNode }>(render)
  const video = (el.type === 'div' ? el.props.children : el) as ReactElement<VideoAttachmentProps>
  expect(video.type).toBe(VideoAttachment)
  return video
}

type Opens = { open: ((x: number, y: number) => void) | null; onError(code: number): void }

// The rows of the menu a video opens on right-click, as it reads itself.
const rowsOf = (video: ReactElement<VideoAttachmentProps>) => {
  const body = returned<Opens>(() => VideoAttachment(video.props))
  body.props.open?.(1, 2)
  const rows = useStore.getState().contextMenu?.items.map(i => i.label) ?? []
  useStore.setState({ contextMenu: null })
  return rows
}

const base = {
  src: 'blob:clip',
  name: 'clip.mp4',
  shown: 'clip.mp4',
  primary: { label: 'Download' as const, onClick: () => {} },
  moves: false,
  open: () => {},
  onError: () => {},
}

const body = (over: Partial<Parameters<typeof VideoAttachmentBody>[0]> = {}) =>
  renderToStaticMarkup(<VideoAttachmentBody {...base} {...over} />)

const pillOf = (html: string) =>
  (/<div class="(absolute top-2 right-2[^"]*)">/.exec(html)?.[1] ?? '').split(' ')

describe('video attachment', () => {
  test('plays inline with the passive player and one download button', () => {
    const html = body()
    expect(html).toContain('<video src="blob:clip" controls="" preload="metadata" playsInline=""')
    expect(html).toContain('group/video')
    expect(html).toContain('aria-label="Download clip.mp4"')
    expect(html).toContain('title="Download clip.mp4"')
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).toContain('lucide-download')
    expect(html.includes('lucide-star')).toBe(false)
    expect(html).toContain('playsInline="" aria-label="clip.mp4"')
    expect(html.includes('style=')).toBe(false)
  })

  test("a size the sender gave holds the video's place before it loads", () => {
    expect(body({ w: 1920, h: 1080 })).toContain('style="width:569px;aspect-ratio:1920 / 1080"')
  })

  test('the pill shows on hover and keyboard focus, always on touch', () => {
    const cls = pillOf(body())
    for (const c of [
      'opacity-0',
      'group-hover/video:opacity-100',
      'group-has-[:focus-visible]/video:opacity-100',
      'max-md:opacity-100',
      'pointer-coarse:opacity-100',
    ])
      expect(cls).toContain(c)
    expect(cls.some(c => c.startsWith('transition'))).toBe(false)
    expect(pillOf(body({ moves: true }))).toContain('transition-[opacity,scale]')
  })

  test('a link downloads by address; a hint goes in the title only; Save for a stored file', () => {
    const link = body({
      primary: { label: 'Download', href: '/api/media/m1', download: 'clip.mp4' },
    })
    expect(link).toContain('<a href="/api/media/m1" download="clip.mp4"')
    expect(link.includes('<button')).toBe(false)
    const hinted = body({
      primary: { label: 'Download', onClick: () => {}, hint: "from bob's browser" },
    })
    expect(hinted).toContain('title="Download clip.mp4 from bob&#x27;s browser"')
    expect(hinted).toContain('aria-label="Download clip.mp4"')
    expect(body({ primary: { label: 'Save', onClick: () => {} } })).toContain(
      'aria-label="Save clip.mp4"'
    )
    expect(body({ primary: { label: 'Download', disabled: true } })).toContain('disabled=""')
  })

  test('the label and title use the name as the filter shows it', () => {
    const html = body({ name: 'shit.mp4', shown: '****.mp4' })
    expect(html.includes('shit')).toBe(false)
    expect(html).toContain('aria-label="Download ****.mp4"')
  })

  test('carries its data hooks and what goes under the player', () => {
    const html = body({ data: { 'data-p2p-file': 'h1' }, children: <p>under</p> })
    expect(html).toContain('data-p2p-file="h1"')
    expect(html).toContain('data-video-attachment')
    expect(html.indexOf('<p>under</p>')).toBeGreaterThan(html.indexOf('<video'))
  })

  test('while a download it started runs, the pill cancels it and a bar says how far', () => {
    const html = body({ progress: { got: 4, total: 10 }, onCancel: () => {} })
    expect(html).toContain('title="Cancel download" aria-label="Cancel download"')
    expect(html).toContain('lucide-x')
    expect(html.includes('aria-label="Download clip.mp4"')).toBe(false)
    expect(html).toContain(
      'role="progressbar" aria-label="Downloading clip.mp4" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"'
    )
    expect(html).toContain('>Downloading 40%</p>')
    expect(body({ progress: { got: 4, total: 10 } })).toContain('aria-label="Download clip.mp4"')
    expect(body().includes('progressbar')).toBe(false)
  })

  const failing: VideoAttachmentProps = {
    src: 'blob:fails-to-play',
    name: 'clip.mp4',
    own: false,
    fileMask: true,
    primary: { label: 'Download', onClick: () => {} },
    menu: { download: null, link: null },
    fallback: <p>the card</p>,
  }

  const DECODE = 3
  const UNSUPPORTED = 4
  const NETWORK = 2

  test('live bytes that cannot play show the card from then on, until the session ends', () => {
    const live = (src: string) => src.startsWith('blob:')
    const props = { ...failing, remember: { key: 'key-of-the-bytes', live } }
    expect(renderToStaticMarkup(<VideoAttachment {...props} />)).toContain('<video')
    returned<Opens>(() => VideoAttachment(props)).props.onError(DECODE)
    expect(renderToStaticMarkup(<VideoAttachment {...props} />)).toBe('<p>the card</p>')
    expect(renderToStaticMarkup(<VideoAttachment {...props} src="blob:same-bytes-again" />)).toBe(
      '<p>the card</p>'
    )
    const other = { ...props, remember: { key: 'other-bytes', live } }
    expect(renderToStaticMarkup(<VideoAttachment {...other} />)).toContain('<video')
    returned<Opens>(() => VideoAttachment(other)).props.onError(UNSUPPORTED)
    expect(renderToStaticMarkup(<VideoAttachment {...other} />)).toBe('<p>the card</p>')
    client.shown().media.clear()
    expect(renderToStaticMarkup(<VideoAttachment {...props} />)).toContain('<video')
  })

  test('a failure to load, or of a URL its owner dropped, lasts only for that mount', () => {
    const memory = client.shown().media.videoFailures
    const loading = { ...failing, remember: { key: 'net-bytes', live: () => true } }
    returned<Opens>(() => VideoAttachment(loading)).props.onError(NETWORK)
    expect(memory.has('net-bytes')).toBe(false)
    expect(renderToStaticMarkup(<VideoAttachment {...loading} />)).toContain('<video')
    const dropped = { ...failing, remember: { key: 'dropped-bytes', live: () => false } }
    returned<Opens>(() => VideoAttachment(dropped)).props.onError(DECODE)
    expect(memory.has('dropped-bytes')).toBe(false)
    expect(renderToStaticMarkup(<VideoAttachment {...dropped} />)).toContain('<video')
  })

  test('a video played from its address tries again on its next mount', () => {
    const props = { ...failing, src: '/api/v1/media/m1' }
    returned<Opens>(() => VideoAttachment(props)).props.onError(DECODE)
    expect(renderToStaticMarkup(<VideoAttachment {...props} />)).toContain('<video')
    expect(client.shown().media.videoFailures.has('/api/v1/media/m1')).toBe(false)
  })

  test('only an enabled button or a link changes color on hover', () => {
    const cls = (html: string, tag: string) =>
      (new RegExp(`<${tag} [^>]*class="([^"]*)"`).exec(html)?.[1] ?? '').split(' ')
    expect(cls(body(), 'button')).toContain('hover-idle:bg-on-surface/8')
    expect(cls(body(), 'button').some(c => c.startsWith('hover:'))).toBe(false)
    const link = body({ primary: { label: 'Download', href: '/api/media/m1' } })
    expect(cls(link, 'a')).toContain('hover-idle:bg-on-surface/8')
  })

  test('without a menu of its own, right-click and long-press are the row around it', () => {
    const el = VideoAttachmentBody({ ...base, open: null }) as ReactElement<Record<string, unknown>>
    expect(Object.keys(el.props).filter(k => /^on|long-press/.test(k))).toEqual([])
  })

  test("a right-click opens the video's menu and not the message's around it", () => {
    const opened: string[] = []
    const el = VideoAttachmentBody({
      ...base,
      open: (x, y) => void opened.push(`video ${x},${y}`),
    }) as ReactElement<{ onContextMenu(e: unknown): void }>
    const event = {
      nativeEvent: new Event('contextmenu'),
      currentTarget: null,
      preventDefault: () => {},
      clientX: 3,
      clientY: 4,
    }
    el.props.onContextMenu(event)
    longPress((x, y) => void opened.push(`row ${x},${y}`)).onContextMenu(event as never)
    expect(opened).toEqual(['video 3,4'])
  })
})

describe('a hosted video', () => {
  const at = Math.floor(Date.now() / 1000) + 400 * 86_400
  const clip = media({ filename: 'clip.mp4', mime: 'video/mp4', size: 2048, expires_at: at })
  const render = (file = clip) =>
    renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { author: user('bob'), media: file })} canDelete />
    )

  test('plays inline from its address, with its expiry under it', () => {
    const html = render()
    expect(/<video src="[^"]*\/media\/m1" controls=""/.test(html)).toBe(true)
    const link = /<a href="[^"]*\/media\/m1" download="clip.mp4" title="Download clip.mp4"/
    expect(link.test(html)).toBe(true)
    expect(html).toContain('aria-label="Download clip.mp4"')
    expect(html).toContain('>Expires on ')
    expect(html.includes('data-file-card')).toBe(false)
  })

  test('where media is fetched, it holds its place while its bytes load; past the cap it is a card', () => {
    mode = 'blob'
    const html = render()
    expect(html).toContain('data-video-waiting="" role="status" aria-label="Loading clip.mp4"')
    expect(html).toContain('aspect-video w-80')
    expect(html).toContain('>Expires on ')
    expect(html.includes('data-video-attachment=')).toBe(false)
    expect(html).toContain('aria-label="Remove attachment"')
    expect(html.includes('<video')).toBe(false)
    const big = render({ ...clip, size: PREVIEW_MAX + 1 })
    expect(big).toContain('data-file-card')
    expect(big.includes('data-video-attachment=')).toBe(false)
  })

  test('fetched bytes that are no video show the card; a video waits until it holds its bytes', async () => {
    mode = 'blob'
    const acct = client.shown()
    const realBlob = acct.api.authedBlob
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...Array.from('ftypisom', c => c.charCodeAt(0))])
    acct.api.authedBlob = async (url: string) =>
      new Blob([url.endsWith('/fetched-text') ? new TextEncoder().encode('just text') : mp4])
    try {
      const held = ['fetched-text', 'fetched-clip'].map(id =>
        acct.media.acquire(acct.api.mediaUrl(id), undefined, 'video', 12)
      )
      await Promise.all(held.map(h => h.url))
      const text = render(media({ ...clip, id: 'fetched-text' }))
      expect(text).toContain('data-file-card')
      expect(text.includes('<video')).toBe(false)
      const waiting = render(media({ ...clip, id: 'fetched-clip' }))
      expect(
        acct.media.peek(acct.api.mediaUrl('fetched-clip'), undefined, 'video')?.startsWith('blob:')
      ).toBe(true)
      expect(waiting.includes('<video')).toBe(false)
      expect(waiting).toContain('data-video-waiting="" role="status"')
      for (const h of held) h.release()
    } finally {
      acct.api.authedBlob = realBlob
    }
  })

  test("its own message's video has no corner remove button, but the menu has the row", () => {
    const html = render()
    expect(html).toContain('aria-label="Remove attachment"')
    expect(html).toContain('group-has-[[data-video-attachment]]/att:hidden')
    let removed = 0
    const video = videoOf(() =>
      MediaAttachment({ media: clip, own: true, postedAt: 0, remove: () => removed++ })
    )
    expect(rowsOf(video)).toEqual(['Download', 'Copy link', 'Copy file name', 'Remove attachment'])
    video.props.menu.remove?.()
    expect(removed).toBe(1)
  })

  test('a declared video type plays a file with no video name', () => {
    expect(render(media({ filename: 'recording', mime: 'video/webm', size: 10 }))).toContain(
      '<video'
    )
  })

  test('the pill fades in only while animations play', () => {
    expect(pillOf(render()).some(c => c.startsWith('transition'))).toBe(false)
    Object.assign(initial, { anim: { on: true, motion: 'always', style: 'subtle', custom: {} } })
    expect(pillOf(render())).toContain('transition-[opacity,scale]')
  })

  test('with previews off it is a file card', () => {
    Object.assign(initial, { settings: { ...initial.settings, asset_previews: false } })
    const html = render()
    expect(html.includes('<video')).toBe(false)
    expect(html).toContain('data-file-card')
    expect(html).toContain('lucide-file-play')
  })

  test('a file that is no video it plays is a file card', () => {
    const html = render(media({ filename: 'movie.mkv', mime: 'video/x-matroska', size: 10 }))
    expect(html.includes('<video')).toBe(false)
    expect(html).toContain('data-file-card')
  })

  test('a spoiler hides the player until revealed', () => {
    const html = render({ ...clip, spoiler: true })
    expect(html.includes('<video')).toBe(false)
    expect(html).toContain('aria-label="Spoiler attachment, press to reveal"')
    Object.assign(initial, { showSpoilers: 'always' })
    expect(render({ ...clip, spoiler: true })).toContain('<video')
  })

  test('a removed video says so and loads nothing', () => {
    const html = render({ ...clip, removed: true, removed_by_author: true })
    expect(html.includes('<video')).toBe(false)
    expect(html).toContain('Attachment removed')
  })
})

describe('a P2P-hosted video in a hosted message', () => {
  test('a fetched preview plays with the pill and the P2P line under it', () => {
    Object.assign(initial, {
      me: null,
      settings: { ...initial.settings, p2p_attachments: true },
    })
    client.shown().files.keepPreview(90_001, { url: 'blob:p2p-clip', kind: 'video' })
    const file = media({
      filename: 'clip.mp4',
      mime: 'video/mp4',
      kind: 'p2p',
      hoster: 'bob',
      sha256: 'ab',
    })
    const html = renderToStaticMarkup(
      <MarkdownMessage message={msg(90_001, { author: user('bob'), media: file })} />
    )
    expect(html).toContain('<video src="blob:p2p-clip"')
    expect(html).toContain('title="Download clip.mp4 from bob&#x27;s browser"')
    expect(html).toContain('aria-label="Download clip.mp4"')
    expect(html.indexOf('>P2P<')).toBeGreaterThan(html.indexOf('<video'))
    expect(html.includes('data-file-card')).toBe(false)
  })
})

describe("a video's menu", () => {
  const clip = media({ id: 'v1', filename: 'clip.mp4', mime: 'video/mp4', size: 2048 })

  test('a hosted video offers Download, its full address to copy, and its name', () => {
    const el = videoOf(() => MediaAttachment({ media: clip, own: false, postedAt: 0 }))
    const acct = client.shown()
    expect(el.props.menu.link).toBe(new URL(acct.api.mediaUrl('v1'), acct.shareOrigin).href)
    expect(rowsOf(el)).toEqual(['Download', 'Copy link', 'Copy file name'])
  })

  test('a P2P video in a hosted message has no link, and Cancel while its download runs', () => {
    Object.assign(initial, {
      me: null,
      settings: { ...initial.settings, p2p_attachments: true },
      p2pAvailability: { bob: { online: true, ids: ['p9'] } },
    })
    client.shown().files.keepPreview(90_002, { url: 'blob:p2p-menu', kind: 'video' })
    const file = { ...clip, id: 'p9', kind: 'p2p' as const, hoster: 'bob', sha256: 'ab' }
    const el = videoOf(() => P2pFile({ media: file, messageId: 90_002 }))
    expect(el.props.remember?.live('blob:p2p-menu')).toBe(true)
    expect(el.props.menu.link).toBeNull()
    expect(rowsOf(el)).toEqual(['Download', 'Copy file name'])
    const running = { ...el, props: { ...el.props, progress: { got: 1, total: 4 } } }
    expect(rowsOf(running)).toEqual(['Cancel download', 'Copy file name'])
    const removable = videoOf(() => P2pFile({ media: file, messageId: 90_002, remove: () => {} }))
    client.shown().files.keepPreview(90_002, { url: 'blob:p2p-menu-again', kind: 'video' })
    expect(el.props.remember?.live('blob:p2p-menu')).toBe(false)
    expect(rowsOf(removable)).toEqual(['Download', 'Copy file name', 'Remove attachment'])
  })

  test('a P2P room video on the device is saved', () => {
    const att = { h: 'h9', size: 2048, blocks: 1, name: 'clip.webm', mime: 'video/webm' }
    const v = {
      state: 'done' as const,
      got: 2048,
      total: 2048,
      holders: 1,
      type: 'video/webm',
      error: null,
      own: true,
      paused: null,
    }
    const props = {
      att,
      canFetch: true,
      own: true,
      v,
      url: 'blob:room-clip',
      thumb: null,
      save: () => {},
      get: () => {},
      cancel: () => {},
    }
    const el = videoOf(() => TileView(props))
    expect(el.props.menu.link).toBeNull()
    expect(rowsOf(el)).toEqual(['Save', 'Copy file name'])
    const html = renderToStaticMarkup(<TileView {...props} />)
    expect(html).toContain('data-p2p-file="h9" data-video-attachment=""')
    expect(html).toContain('<video src="blob:room-clip"')
    expect(html).toContain('aria-label="Save clip.webm"')
    const sized = { ...props, att: { ...att, w: 1280, h_px: 720 } }
    expect(renderToStaticMarkup(<TileView {...sized} />)).toContain(
      'style="width:569px;aspect-ratio:1280 / 720"'
    )
  })

  test('in a row in selection mode it leaves right-click and long-press to the row', () => {
    const m = msg(9, { author: user('bob'), media: clip })
    const row = () =>
      renderToStaticMarkup(
        <Selectable m={m} scope="c1">
          <MarkdownMessage message={m} />
        </Selectable>
      )
    Object.assign(initial, { me: me('alice'), selection: null })
    expect(row()).toContain('<div data-long-press="" data-video-attachment=""')
    Object.assign(initial, { selection: emptySelection('c1') })
    const html = row()
    expect(html).toContain('data-selectable=""')
    expect(html).toContain('<div data-video-attachment=""')
    expect(html.includes('data-long-press="" data-video-attachment')).toBe(false)
  })
})

describe('a video while it loads', () => {
  const props = {
    name: 'clip.mp4',
    own: true,
    fileMask: true,
    primary: { label: 'Download' as const, onClick: () => {} },
    menu: { download: () => {}, link: null, remove: () => {} },
    box: null,
    loading: true,
  }

  test('says so while its bytes load, and holds the size it last had in pixels', () => {
    const html = renderToStaticMarkup(<VideoPlaceholder {...props} />)
    expect(html).toContain('role="status" aria-label="Loading clip.mp4"')
    expect(html).toContain('motion-safe:animate-pulse')
    expect(html).toContain('aspect-video w-80')
    const sized = renderToStaticMarkup(<VideoPlaceholder {...props} box={{ w: 1280, h: 720 }} />)
    expect(sized).toContain('style="width:569px;aspect-ratio:1280 / 720"')
    expect(sized.includes('aspect-video')).toBe(false)
  })

  test('away from the view and not loading, it is a plain box named for the file', () => {
    const html = renderToStaticMarkup(<VideoPlaceholder {...props} loading={false} />)
    expect(html).toContain('role="group" aria-label="clip.mp4"')
    expect(html.includes('status')).toBe(false)
    expect(html.includes('Loading')).toBe(false)
    expect(html.includes('animate-pulse')).toBe(false)
  })

  test('keeps the file menu on right-click and long-press', () => {
    const el = returned<{ onContextMenu(e: unknown): void }>(() => VideoPlaceholder(props))
    el.props.onContextMenu({
      nativeEvent: new Event('contextmenu'),
      currentTarget: null,
      preventDefault: () => {},
      clientX: 3,
      clientY: 4,
    })
    expect(useStore.getState().contextMenu?.items.map(i => i.label)).toEqual([
      'Download',
      'Copy file name',
      'Remove attachment',
    ])
    useStore.setState({ contextMenu: null })
  })
})
