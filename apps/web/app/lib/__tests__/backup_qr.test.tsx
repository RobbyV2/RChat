import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import jsQR from 'jsqr'
import { normalize, qrPayload } from '../backup_phrase'
import { qrMatrix, qrSvg, sheetAction, sheetHtml } from '../backup_qr'
import { PhraseExport, PhraseQr } from '../../components/backup_phrase/phrase_qr'

const W =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(
    ' '
  )

const LONG =
  'mosquito document language umbrella physical kangaroo solution surprise bachelor universe decorate elevator'.split(
    ' '
  )

describe('backup phrase QR', () => {
  // The largest symbol, 69 modules (version 11), comes from 12 eight-letter words.
  for (const [name, words] of [
    ['short words', W],
    ['the longest words', LONG],
  ] as const) {
    test(`the QR with its logo hole still decodes to the payload (${name})`, () => {
      const m = qrMatrix(words)
      const scale = 4
      const side = m.size * scale
      const rgba = new Uint8ClampedArray(side * side * 4)
      for (let y = 0; y < side; y++)
        for (let x = 0; x < side; x++) {
          const v = m.dark[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255
          rgba.set([v, v, v, 255], (y * side + x) * 4)
        }
      expect(jsQR(rgba, side, side)?.data).toBe(qrPayload(words))
    })

    test(`the hole covers at most 20% of the symbol and sits in the middle (${name})`, () => {
      const { size, hole, dark } = qrMatrix(words)
      const inner = size - 8
      expect(hole.side * hole.side).toBeLessThanOrEqual(0.2 * inner * inner)
      expect(Math.abs(hole.x + hole.side / 2 - size / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(hole.y + hole.side / 2 - size / 2)).toBeLessThanOrEqual(1)
      for (let y = hole.y; y < hole.y + hole.side; y++)
        for (let x = hole.x; x < hole.x + hole.side; x++) expect(dark[y][x]).toBe(false)
    })
  }

  test('the longest phrase makes the largest symbol', () => {
    expect(normalize(LONG.join(' '))).toEqual(LONG)
    expect(qrMatrix(LONG).size).toBe(69)
  })

  test('the SVG and the sheet load nothing from outside', () => {
    const svg = qrSvg(W, 'data:image/png;base64,AAAA')
    expect(/(href|src)="(?!data:|#)/.test(svg)).toBe(false)
    expect(svg).toContain('data:image/png;base64,AAAA')
    const html = sheetHtml({
      words: W,
      kind: 'account',
      account: 'alice',
      host: 'chat.example.com',
      date: '2026-11-04',
      svg,
    })
    expect(/<script|(href|src)="(?!data:|#)/.test(html)).toBe(false)
    W.forEach((w, i) => expect(html).toContain(`${i + 1}. ${w}`))
    expect(html).toContain('alice')
    expect(html).toContain('chat.example.com')
    expect(html).toContain('2026-11-04')
  })

  test('the SVG leaves the logo out when it gets no image data', () => {
    expect(qrSvg(W, '')).not.toContain('<image')
    expect(qrSvg(W, 'https://example.com/logo.png')).not.toContain('<image')
  })

  test('the sheet escapes names and says when a phrase is P2P only', () => {
    const svg = qrSvg(W, '')
    const html = sheetHtml({
      words: W,
      kind: 'account',
      account: '<b>x</b>',
      host: 'a&b',
      date: '2026-11-04',
      svg,
    })
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('a&amp;b')
    expect(html).not.toContain('<b>x</b>')
    const p2p = sheetHtml({ words: W, kind: 'p2p', account: '', host: '', date: '2026-11-04', svg })
    expect(p2p).toContain('P2P')
    expect(p2p).not.toContain('Instance')
  })

  test('PhraseQr renders nothing of the phrase while hidden', () => {
    const html = renderToStaticMarkup(<PhraseQr words={W} hidden />)
    expect(html).not.toContain('abandon')
    expect(html).not.toContain('<path')
    expect(html).not.toContain('data:image/svg')
    expect(renderToStaticMarkup(<PhraseQr words={W} hidden={false} />)).toContain(
      'data:image/svg+xml'
    )
  })

  test('Print where the platform prints, Save sheet where it cannot, nothing until known', () => {
    expect(sheetAction(true)).toBe('print')
    expect(sheetAction(false)).toBe('save')
    expect(sheetAction(null)).toBeNull()
  })

  // The first paint can't know the platform: the slot keeps its size and shows nothing.
  test('the print slot is reserved but empty before the platform is known', () => {
    const html = renderToStaticMarkup(<PhraseExport words={W} kind="account" />)
    const buttons = [...html.matchAll(/<button[^>]*>.*?<\/button>/g)].map(m => m[0])
    expect(buttons).toHaveLength(2)
    expect(buttons.some(b => b.includes('Print') || b.includes('Save sheet'))).toBe(false)
    expect(
      /<span[^>]*aria-hidden="true"[^>]*class="[^"]*invisible[^"]*"[^>]*>.*Save sheet/.test(html)
    ).toBe(true)
    expect(html).not.toContain('abandon')
  })
})
