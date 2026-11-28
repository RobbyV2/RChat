import { afterEach, describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { longPress } from '../../components/context_menu'
import { FileCardBody } from '../../components/file_card'
import { MarkdownMessage } from '../../components/markdown_message'
import { Selectable } from '../../components/selection'
import { emptySelection } from '../selection'
import { useStore } from '../store'
import { me, media, msg, user } from './fixtures'
import { readText } from './masked_text'

const initial = useStore.getInitialState()
const saved = { ...initial }
afterEach(() => void Object.assign(initial, saved))

const base = {
  name: 'Mandy Save.zip',
  shown: 'Mandy Save.zip',
  kind: 'archive' as const,
  size: 864_051,
  progress: null,
  primary: { label: 'Download' as const, onClick: () => {} },
  open: () => {},
}

const card = (over: Partial<Parameters<typeof FileCardBody>[0]> = {}) =>
  renderToStaticMarkup(<FileCardBody {...base} {...over} />)

const classOf = (html: string, re: RegExp) => (re.exec(html)?.[1] ?? '').split(' ')

describe('file card', () => {
  test('the extension sits in its own element that never shrinks; the base truncates', () => {
    const html = card()
    expect(classOf(html, /<span data-file-ext="" class="([^"]*)">\.zip<\/span>/)).toContain(
      'shrink-0'
    )
    expect(classOf(html, /<span class="([^"]*)">Mandy Save<\/span>/)).toContain('truncate')
    expect(html).toContain('title="Mandy Save.zip"')
    expect(html).toContain('844 KB')
    expect(html).toContain('lucide-file-archive')
  })

  test('the size line carries the detail', () => {
    expect(card({ detail: ' · 1:23' })).toContain('844 KB · 1:23')
    expect(card({ size: null, detail: undefined }).includes('KB')).toBe(false)
  })

  test('only an enabled button or a link changes color on hover', () => {
    const button = (html: string) => classOf(html, /<button[^>]* class="([^"]*)"/)
    expect(button(card())).toContain('enabled:hover:bg-primary/90')
    expect(button(card()).includes('hover:bg-primary/90')).toBe(false)
    const off = card({ primary: { label: 'Download', disabled: true } })
    expect(button(off)).toContain('disabled:opacity-40')
    expect(button(off).includes('hover:bg-primary/90')).toBe(false)
    const link = card({ primary: { label: 'Download', href: '/api/media/f1' } })
    expect(classOf(link, /<a [^>]*class="([^"]*)"/)).toContain('hover:bg-primary/90')
  })

  test("the button's label and title name the shown file; a hint goes in the title only", () => {
    const html = card()
    expect(html).toContain('aria-label="Download Mandy Save.zip"')
    expect(html).toContain('title="Download Mandy Save.zip"')
    const hinted = card({
      primary: { label: 'Download', onClick: () => {}, hint: "from bob's browser" },
    })
    expect(hinted).toContain('title="Download Mandy Save.zip from bob&#x27;s browser"')
    expect(hinted).toContain('aria-label="Download Mandy Save.zip"')
    expect(card({ primary: { label: 'Save', onClick: () => {} } })).toContain(
      'aria-label="Save Mandy Save.zip"'
    )
    expect(card({ primary: { label: 'Download', disabled: true } })).toContain('disabled=""')
  })

  test('a link downloads by address', () => {
    const html = card({ primary: { label: 'Download', href: '/api/media/f1', download: 'a.zip' } })
    expect(html).toContain('<a href="/api/media/f1" download="a.zip"')
    expect(html.includes('<button')).toBe(false)
  })

  test('masked halves line up with the raw name, and the raw words stay out', () => {
    const html = card({ name: 'shit.zip', shown: '****.zip' })
    expect(html.includes('shit')).toBe(false)
    expect(html).toContain('data-masked-word')
    expect(html).toContain('title="****.zip"')
    expect(html).toContain('aria-label="Download ****.zip"')
    const text = readText(html)
    expect(text).toContain('truncate font-semibold text-on-surface">****</span>')
    expect(text).toContain('text-on-surface-variant">.zip</span>')
    const both = readText(card({ name: 'bad.ts', shown: '***.**' }))
    expect(both).toContain('text-on-surface">***</span>')
    expect(both).toContain('text-on-surface-variant">.**</span>')
    expect(both.includes('bad')).toBe(false)
  })

  test('the other buttons sit before the main one, each with its title and label', () => {
    const run = () => {}
    const html = card({
      extra: [
        { kind: 'image', hint: '(connects to the sender)', run },
        { kind: 'preview', hint: '(connects to the sender)', run },
        { kind: 'video', run },
      ],
    })
    expect(html).toContain('title="Show image (connects to the sender)" aria-label="Show image"')
    expect(html).toContain(
      'title="Show preview (connects to the sender)" aria-label="Show preview"'
    )
    expect(html).toContain('title="Play video" aria-label="Play video"')
    expect(html.indexOf('aria-label="Play video"')).toBeLessThan(
      html.indexOf('aria-label="Download Mandy Save.zip"')
    )
  })

  test('Cancel takes the button while a download runs, with the progress bar', () => {
    const extra = [{ kind: 'image' as const, run: () => {} }]
    expect(card({ extra })).toContain('aria-label="Show image"')
    const html = card({ extra, progress: { got: 42, total: 100 }, onCancel: () => {} })
    expect(html).toContain('aria-label="Cancel download"')
    expect(html).toContain('title="Cancel download"')
    expect(html).toContain('Downloading 42%')
    expect(html).toContain('role="progressbar" aria-label="Downloading Mandy Save.zip"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html.includes('aria-label="Download Mandy Save.zip"')).toBe(false)
    expect(html.includes('aria-label="Show image"')).toBe(false)
    expect(html.includes('844 KB')).toBe(false)
  })

  test('the P2P look is dashed; an unavailable file is dimmed', () => {
    expect(card({ dashed: true })).toContain('border-dashed border-tertiary/60')
    expect(card().includes('border-dashed')).toBe(false)
    expect(card({ dim: true })).toContain('opacity-60')
    expect(card({ data: { 'data-p2p-file': 'h1', 'data-state': 'none' } })).toContain(
      'data-p2p-file="h1" data-state="none"'
    )
  })

  test("a right-click opens the card's menu and not the message's around it", () => {
    const opened: string[] = []
    const el = FileCardBody({
      ...base,
      open: (x, y) => void opened.push(`card ${x},${y}`),
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
    expect(opened).toEqual(['card 3,4'])
  })

  test('without a menu of its own, right-click and long-press are the row around it', () => {
    const opened: string[] = []
    const el = FileCardBody({ ...base, open: null }) as ReactElement<
      Record<string, ((e: unknown) => void) | undefined>
    >
    expect(Object.keys(el.props).filter(k => /^on|long-press/.test(k))).toEqual([])
    const event = {
      nativeEvent: new Event('contextmenu'),
      currentTarget: null,
      preventDefault: () => {},
      clientX: 5,
      clientY: 6,
    }
    longPress((x, y) => void opened.push(`row ${x},${y}`)).onContextMenu(event as never)
    expect(opened).toEqual(['row 5,6'])
  })
})

describe('a file card in selection mode', () => {
  const m = msg(9, {
    author: user('bob'),
    media: media({ filename: 'notes.zip', mime: 'application/zip', size: 4096 }),
  })
  const row = () =>
    renderToStaticMarkup(
      <Selectable m={m} scope="c1">
        <MarkdownMessage message={m} />
      </Selectable>
    )

  test('leaves right-click and long-press to its row, for the selection menu', () => {
    Object.assign(initial, { me: me('alice'), selection: null })
    expect(row()).toContain('<div data-long-press="" data-file-card=""')
    Object.assign(initial, { selection: emptySelection('c1') })
    const html = row()
    expect(html).toContain('data-selectable=""')
    expect(html).toContain('<div data-file-card=""')
    expect(html.includes('data-long-press="" data-file-card')).toBe(false)
    Object.assign(initial, { selection: emptySelection('t4') })
    expect(row()).toContain('<div data-long-press="" data-file-card=""')
  })
})

describe('a hosted file', () => {
  const at = Math.floor(Date.now() / 1000) + 400 * 86_400
  const file = media({
    filename: 'report.pdf',
    mime: 'application/pdf',
    size: 2048,
    expires_at: at,
  })

  test('shows as a card with its expiry under it', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { author: user('bob'), media: file })} canDelete />
    )
    expect(html).toContain('data-file-card')
    expect(html).toContain('lucide-file-text')
    expect(html).toContain('aria-label="Download report.pdf"')
    expect(html).toContain('2 KB')
    expect(html).toContain('>Expires on ')
    expect(html).toContain('aria-label="Remove attachment"')
  })

  test('a file that does not expire has no expiry line', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { media: { ...file, expires_at: null } })} />
    )
    expect(html).toContain('data-file-card')
    expect(html.includes('Expires')).toBe(false)
  })

  test('a P2P file whose sender is away is a dimmed card with its button off', () => {
    Object.assign(initial, {
      me: null,
      settings: { ...initial.settings, p2p_attachments: true },
    })
    const p2p = { ...file, kind: 'p2p' as const, hoster: 'bob', expires_at: null, sha256: null }
    const html = renderToStaticMarkup(
      <MarkdownMessage message={msg(5, { author: user('bob'), media: p2p })} />
    )
    expect(html).toContain('data-file-card="" class="msg-part w-md max-w-full min-w-0 opacity-60"')
    expect(html).toContain('title="Download report.pdf from bob&#x27;s browser"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="File not available. Ask bob to send it again."')
  })
})
