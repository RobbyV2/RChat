import { describe, expect, test } from 'bun:test'
import {
  VGA,
  profileRetroButtons,
  retroButtonLabel,
  serverRetroButtons,
  type RetroButton,
} from '../../apps/web/app/lib/fx/retro_buttons'
import {
  RETRO_BUTTON_CSS,
  STYLES,
  VARIANTS,
  buttonHtml,
  faults,
  galleryButtons,
  galleryHtml,
  wallHtml,
  type Measured,
} from './retro_button_gallery'

const count = (text: string, part: string) => text.split(part).length - 1
const since: RetroButton = profileRetroButtons({ createdAt: 1_710_000_000, now: 1_760_000_000 })[0]

describe('one web button', () => {
  test('is an image to assistive tech, named by its words, with its text hidden from them', () => {
    const html = buttonHtml(since)
    expect(html).toContain('role="img"')
    expect(html).toContain(`aria-label="${retroButtonLabel(since)}"`)
    expect(html).toContain('aria-label="Since 2024"')
    expect(count(html, 'aria-hidden="true"')).toBe(2)
    expect(html).toContain('<span>SINCE</span><span>2024</span>')
  })

  test('is DOM text in its VGA colors: no image, canvas or drawing', () => {
    const html = buttonHtml(since)
    expect(/<(img|canvas|svg|picture|object)\b/.test(html)).toBe(false)
    expect(html).toContain(`--rb-bg:${VGA[since.bg]}`)
    expect(html).toContain(`--rb-fg:${VGA[since.fg]}`)
  })

  test('takes its own style, or the one asked for', () => {
    expect(buttonHtml(since)).toContain('class="retro-button retro-split"')
    for (const style of STYLES)
      expect(buttonHtml(since, style)).toContain(`class="retro-button retro-${style}"`)
    expect([...STYLES]).toEqual(['bevel', 'flat', 'split'])
  })

  test('one line and no emblem when it has none', () => {
    const plain: RetroButton = { ...since, line2: null, emblem: null }
    const html = buttonHtml(plain)
    expect(html).toContain('<span>SINCE</span></span>')
    expect(html.includes('retro-emblem')).toBe(false)
    expect(count(html, 'aria-hidden="true"')).toBe(1)
  })

  test('text is escaped', () => {
    const odd: RetroButton = { ...since, line1: 'A&B <1>', line2: '"x"', emblem: null }
    const html = buttonHtml(odd)
    expect(html).toContain('<span>A&amp;B &lt;1&gt;</span><span>&quot;x&quot;</span>')
    expect(html).toContain('aria-label="A&amp;b &lt;1&gt; &quot;x&quot;"')
  })
})

describe('the wall', () => {
  test('is its own list under the heading "Web buttons"', () => {
    const buttons = serverRetroButtons({
      createdAt: 1_710_000_000,
      now: 1_760_000_000,
      members: 12,
    })
    const html = wallHtml(buttons)
    expect(html).toContain('>Web buttons</h3>')
    expect(count(html, 'role="list"')).toBe(1)
    expect(count(html, 'role="listitem"')).toBe(buttons.length)
    expect(count(html, 'role="img"')).toBe(buttons.length)
    const order = [...html.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1])
    expect(order).toEqual(buttons.map(retroButtonLabel))
  })
})

describe('the gallery', () => {
  const buttons = galleryButtons()
  const html = galleryHtml(
    ":root[data-style='vintage'] .retro-button { font-family: 'Silkscreen' }\n@font-face { src: url(/fonts/silkscreen-400.woff2) format('woff2') }"
  )

  test('holds every web button the model derives', () => {
    expect([...new Set(buttons.map(b => b.id))].sort()).toEqual(
      ['any', 'cake', 'contact', 'est', 'friend', 'member', 'members', 'since'].sort()
    )
    const words = buttons.map(b => [b.line1, b.line2].filter(Boolean).join(' '))
    expect(new Set(words).size).toBe(words.length)
    for (const want of [
      'SINCE 2024',
      '1 YEAR TODAY',
      '2 YEARS TODAY',
      'MEMBER 2025',
      'FRIEND',
      'CONTACT',
      'EST. 2024',
      '1 MEMBER',
      '12 MEMBERS',
      '1,234 MEMBERS',
      '12K MEMBERS',
      'BIRTHDAY TODAY',
      'BEST VIEWED ANYWHERE',
    ])
      expect([want, words.includes(want)]).toEqual([want, true])
  })

  test('shows each one in every style', () => {
    const grid = html.slice(html.indexOf('id="all"'))
    for (const style of STYLES)
      expect([style, count(grid, `class="retro-button retro-${style}"`)]).toEqual([
        style,
        buttons.length,
      ])
  })

  test('shows the classic cursors the style sheet carries, as they are drawn', () => {
    const arrow = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E")`
    const page = galleryHtml(
      `a { cursor:\n    ${arrow}\n      1 1,\n    default; }\nb { cursor: auto; }`
    )
    expect(count(page, 'class="cursor-art"')).toBe(1)
    expect(page).toContain(
      `style="background-image:url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E&quot;)"`
    )
    expect(page.indexOf('class="cursor-art"')).toBeLessThan(
      page.indexOf('</div></section>\n</body>')
    )
    expect(count(html, 'class="cursor-art"')).toBe(0)
  })

  test('shows a profile wall and a server wall', () => {
    expect(count(html, '>Web buttons</h3>')).toBe(2)
    expect(html.indexOf('id="profile"')).toBeLessThan(html.indexOf('id="server"'))
    expect(html.indexOf('id="server"')).toBeLessThan(html.indexOf('id="all"'))
  })

  test('is one static vintage page: the style sheet inline, fonts beside it, nothing from outside', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="en" data-style="vintage" data-theme="dark">')
    expect(html).toContain("font-family: 'Silkscreen'")
    expect(html).toContain('url(fonts/silkscreen-400.woff2)')
    expect(html.includes('url(/fonts/')).toBe(false)
    expect(html).toContain(RETRO_BUTTON_CSS)
    expect(/<script|<link|<img|https?:\/\/|@import/i.test(html.replace(/xmlns='[^']*'/g, ''))).toBe(
      false
    )
  })
})

describe("the button's own css", () => {
  test('at least 88 by 31, with em padding, growing with its text and never clipping', () => {
    expect(RETRO_BUTTON_CSS).toContain('min-width: 88px;')
    expect(RETRO_BUTTON_CSS).toContain('min-height: 31px;')
    expect(RETRO_BUTTON_CSS).toContain('padding: 0.25em 0.5em;')
    expect(/font-size: [\d.]+rem;/.test(RETRO_BUTTON_CSS)).toBe(true)
    expect(
      /overflow|text-overflow|max-width|max-height|(^|[^-])\b(width|height): /.test(
        RETRO_BUTTON_CSS
      )
    ).toBe(false)
  })

  const rule = (selector: string) => {
    const from = RETRO_BUTTON_CSS.indexOf(`\n${selector} {`)
    return from < 0 ? '' : RETRO_BUTTON_CSS.slice(from, RETRO_BUTTON_CSS.indexOf('}', from))
  }

  test('an emblem is set in the emoji font, and in its own block it takes the other color', () => {
    expect(rule('.retro-emblem')).toContain('font-family: var(--font-emoji);')
    expect(rule('.retro-split .retro-emblem')).toContain('background: var(--rb-fg);')
    expect(rule('.retro-split .retro-emblem')).toContain('color: var(--rb-bg);')
  })

  test('a flat button is outlined in its text color, so a black one shows on a dark wall', () => {
    expect(rule('.retro-flat')).toContain('outline: 1px solid var(--rb-fg);')
    expect(rule('.retro-flat')).toContain('outline-offset: -1px;')
    expect(rule('.retro-split')).toContain('outline: 1px solid #000000;')
  })

  test('forced colors: system colors and an inset outline, never a border', () => {
    const forced = RETRO_BUTTON_CSS.slice(
      RETRO_BUTTON_CSS.indexOf('@media (forced-colors: active)')
    )
    expect(forced.length).toBeGreaterThan(40)
    for (const part of [
      'background: Canvas;',
      'color: CanvasText;',
      'outline: 1px solid ButtonBorder;',
      'outline-offset: -1px;',
      'box-shadow: none;',
    ])
      expect([part, forced.includes(part)]).toEqual([part, true])
    expect(/\bborder(-[a-z]+)?:/.test(RETRO_BUTTON_CSS)).toBe(false)
  })
})

describe('the screenshots', () => {
  test('both themes, plain, in forced colors and with text at 200%', () => {
    expect(VARIANTS.map(v => v.name)).toEqual([
      'dark',
      'dark-forced-colors',
      'dark-text-200',
      'light',
      'light-forced-colors',
      'light-text-200',
    ])
    expect(VARIANTS.filter(v => v.forced).map(v => v.theme)).toEqual(['dark', 'light'])
    expect(VARIANTS.filter(v => v.textZoom === 2).map(v => v.theme)).toEqual(['dark', 'light'])
  })
})

describe('what a measured button must hold', () => {
  const ok: Measured = {
    label: 'Since 2024',
    width: 88,
    height: 31,
    clipped: false,
    font: 'Silkscreen',
    background: 'rgb(0, 0, 128)',
    color: 'rgb(255, 255, 255)',
    style: 'split',
    outline: 'solid',
    outlineColor: 'rgb(0, 0, 0)',
    shadow: 'none',
    emblem: { color: 'rgb(0, 0, 128)', background: 'rgb(255, 255, 255)' },
  }
  const plain = VARIANTS[0]
  const zoomed = VARIANTS[2]
  const forced = VARIANTS[1]

  test('at the default size every button is exactly 88 by 31 in Silkscreen', () => {
    expect(faults(plain, [ok])).toEqual([])
    expect(faults(plain, [{ ...ok, width: 96 }])).toEqual(['dark: Since 2024 is 96x31, not 88x31'])
    expect(faults(plain, [{ ...ok, height: 30.5 }])).toEqual([
      'dark: Since 2024 is 88x30.5, not 88x31',
    ])
    expect(faults(plain, [{ ...ok, font: 'Roboto' }])).toEqual([
      'dark: Since 2024 is set in Roboto, not Silkscreen',
    ])
  })

  test('with text at 200% every button grows and none clips', () => {
    expect(faults(zoomed, [{ ...ok, width: 150, height: 48 }])).toEqual([])
    expect(faults(zoomed, [ok])).toEqual([
      'dark-text-200: Since 2024 did not grow with its text (88x31)',
    ])
    expect(faults(zoomed, [{ ...ok, width: 150, height: 48, clipped: true }])).toEqual([
      'dark-text-200: Since 2024 clips its text',
    ])
  })

  test('an emblem never has the color of its own block', () => {
    const white = 'rgb(255, 255, 255)'
    expect(faults(plain, [{ ...ok, emblem: { color: white, background: white } }])).toEqual([
      'dark: Since 2024 has an emblem the color of its block',
    ])
    expect(faults(plain, [{ ...ok, emblem: null }])).toEqual([])
  })

  test('a flat button has an outline in its text color', () => {
    const green = 'rgb(0, 255, 0)'
    const flat = {
      ...ok,
      label: '12 members',
      style: 'flat' as const,
      background: 'rgb(0, 0, 0)',
      color: green,
      outlineColor: green,
      emblem: null,
    }
    expect(faults(plain, [flat])).toEqual([])
    expect(faults(plain, [{ ...flat, outlineColor: 'rgb(0, 0, 0)' }])).toEqual([
      'dark: 12 members has no outline in its text color',
    ])
    expect(faults(plain, [{ ...flat, outline: 'none' }])).toEqual([
      'dark: 12 members has no outline in its text color',
    ])
    expect(faults(plain, [{ ...ok, style: 'bevel', outline: 'none' }])).toEqual([])
  })

  test('nothing clips in any variant', () => {
    expect(faults(plain, [{ ...ok, clipped: true }])).toEqual(['dark: Since 2024 clips its text'])
  })

  test('in forced colors the outline stands in and the colors are the system ones', () => {
    const system = { canvas: 'rgb(0, 0, 0)', text: 'rgb(255, 255, 255)' }
    const good = { ...ok, background: system.canvas, color: system.text, outline: 'solid' }
    expect(faults(forced, [good], system)).toEqual([])
    expect(faults(forced, [{ ...good, outline: 'none' }], system)).toEqual([
      'dark-forced-colors: Since 2024 has no outline',
    ])
    expect(faults(forced, [{ ...good, background: 'rgb(0, 0, 128)' }], system)).toEqual([
      'dark-forced-colors: Since 2024 keeps its own colors',
    ])
  })
})
