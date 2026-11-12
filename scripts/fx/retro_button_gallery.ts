// The web button gallery: a static page with every derived web button in every style, drawn
// with plain DOM and `apps/web/app/vintage.css`, and its screenshots in both themes, in forced
// colors and with text at 200%. With a Chromium installed it also measures every button
// (exactly 88 by 31 at the default size, growing and never clipping with larger text).
//   bun scripts/fx/retro_button_gallery.ts <out dir>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import {
  VGA,
  profileRetroButtons,
  retroButtonLabel,
  serverRetroButtons,
  type ButtonStyle,
  type RetroButton,
} from '../../apps/web/app/lib/fx/retro_buttons'
import { findChrome } from '../load/lib'

const WEB = join(import.meta.dir, '../../apps/web')
const FONTS = ['pixelify-sans.woff2', 'silkscreen-400.woff2', 'silkscreen-700.woff2']

export const STYLES: readonly ButtonStyle[] = ['bevel', 'flat', 'split']

// The button's own look, the same in every app style. Its face comes from `vintage.css`.
export const RETRO_BUTTON_CSS = `.retro-button {
  display: inline-flex;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  gap: 0.5em;
  min-width: 88px;
  min-height: 31px;
  padding: 0.25em 0.5em;
  background: var(--rb-bg);
  color: var(--rb-fg);
  font-size: 0.5rem;
  line-height: 1.25;
  text-align: center;
  white-space: nowrap;
  vertical-align: top;
  user-select: none;
}
.retro-text {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.retro-emblem {
  font-family: var(--font-emoji);
  font-size: 1.5em;
  line-height: 1;
}
.retro-bevel {
  box-shadow:
    inset 1px 1px rgb(255 255 255 / 0.6),
    inset -1px -1px rgb(0 0 0 / 0.6);
}
.retro-flat {
  outline: 1px solid var(--rb-fg);
  outline-offset: -1px;
}
.retro-split {
  outline: 1px solid #000000;
  outline-offset: -1px;
}
.retro-split {
  align-items: stretch;
  gap: 0;
  padding: 0;
}
.retro-split .retro-emblem {
  display: flex;
  align-items: center;
  padding: 0.167em 0.25em;
  background: var(--rb-fg);
  color: var(--rb-bg);
}
.retro-split .retro-text {
  flex: 1;
  justify-content: center;
  padding: 0.25em 0.5em;
}
@media (forced-colors: active) {
  .retro-button,
  .retro-split .retro-emblem {
    background: Canvas;
    color: CanvasText;
  }
  .retro-button {
    box-shadow: none;
    outline: 1px solid ButtonBorder;
    outline-offset: -1px;
  }
}
`

const PAGE_CSS = `:root {
  --font-sans: Roboto, 'Segoe UI', system-ui, -apple-system, sans-serif;
  --font-emoji: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', var(--font-sans);
}
body {
  margin: 0;
  padding: 16px;
  background: var(--color-surface);
  color: var(--color-on-surface);
  font-family: var(--font-sans);
  font-size: 0.875rem;
}
h1 { font-size: 1.25rem; margin: 0 0 12px; }
h2 { font-size: 1rem; margin: 20px 0 8px; }
h3 { font-size: 0.75rem; margin: 0 0 6px; text-transform: uppercase; color: var(--color-on-surface-variant); }
.card { display: inline-block; max-width: 420px; padding: 12px; }
.retro-wall { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; }
.retro-wall > * { display: flex; }
table { border-collapse: collapse; }
th, td { padding: 4px 10px 4px 0; text-align: left; font-weight: normal; vertical-align: middle; }
th { color: var(--color-on-surface-variant); }
.sample { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 12px; }
.sample > * { padding: 6px 12px; }
.sample .vt-title-bar { display: flex; gap: 12px; align-items: center; }
.cursor-art { display: inline-block; width: 36px; height: 46px; background: no-repeat 0 0 / contain; image-rendering: pixelated; }
`

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// One web button: real text that zooms with the page, read as one image by its words.
export function buttonHtml(b: RetroButton, style: ButtonStyle = b.style): string {
  const lines = [b.line1, b.line2].filter((l): l is string => l !== null)
  const emblem = b.emblem
    ? `<span class="retro-emblem" aria-hidden="true">${escape(b.emblem)}</span>`
    : ''
  return (
    `<span class="retro-button retro-${style}" role="img" aria-label="${escape(retroButtonLabel(b))}"` +
    ` style="--rb-bg:${VGA[b.bg]};--rb-fg:${VGA[b.fg]}">${emblem}` +
    `<span class="retro-text" aria-hidden="true">${lines.map(l => `<span>${escape(l)}</span>`).join('')}</span></span>`
  )
}

// The wall: its own section, last on a card.
export const wallHtml = (buttons: RetroButton[]) =>
  `<h3>Web buttons</h3><div class="retro-wall" role="list">${buttons
    .map(b => `<div role="listitem">${buttonHtml(b)}</div>`)
    .join('')}</div>`

const DAY = 86_400
const MADE = Date.UTC(2024, 2, 9, 12) / 1000
const TODAY = Date.UTC(2026, 2, 9, 12) / 1000
const profile = () =>
  profileRetroButtons({
    createdAt: MADE,
    now: TODAY,
    member: { joinedAt: MADE + 400 * DAY },
    friend: true,
    contact: true,
  })
const server = (members: number, now = TODAY) =>
  serverRetroButtons({ createdAt: MADE, now, members })

// Every web button the model derives, once each.
export function galleryButtons(): RetroButton[] {
  const all = [
    ...profile(),
    ...profileRetroButtons({ createdAt: MADE + 365 * DAY, now: TODAY }).filter(
      b => b.id === 'cake'
    ),
    ...server(1_234),
    ...[1, 12, 12_345].flatMap(n => server(n, TODAY + DAY).filter(b => b.id === 'members')),
  ]
  const seen = new Set<string>()
  return all.filter(b => {
    const words = `${b.line1} ${b.line2}`
    return seen.has(words) ? false : (seen.add(words), true)
  })
}

const CONTROLS = `<div class="sample vt-desktop">
<div class="vt-window"><div class="vt-title-bar"><span class="vt-title">General settings</span><button class="vt-icon-button" title="Close" aria-label="Close">x</button></div>
<p>A window with a title bar.</p><button class="vt-button vt-wide">OK</button> <button class="vt-button vt-wide">Cancel</button></div>
<div class="vt-title-bar vt-off"><span class="vt-title">Thread</span></div>
<input class="vt-field" value="Message #general" aria-label="Sample field">
<div class="vt-menu"><div class="vt-menu-item">Reply</div><div class="vt-menu-item vt-on">Copy text</div></div>
<div class="vt-tile">A</div><div class="vt-tile vt-on">B</div>
<div class="vt-doc">A <a href="#all">link</a> in the message list.</div>
<div class="vt-status">bob is typing...</div>
<span class="vt-new">NEW!</span>
`

// The page. `vintageCss` is `apps/web/app/vintage.css`; its fonts sit in `fonts/` beside it.
export function galleryHtml(vintageCss: string): string {
  const buttons = galleryButtons()
  const rows = buttons
    .map(
      b =>
        `<tr><th scope="row">${escape(retroButtonLabel(b))}</th>${STYLES.map(
          s => `<td>${buttonHtml(b, s)}</td>`
        ).join('')}</tr>`
    )
    .join('\n')
  const cursors = [...vintageCss.matchAll(/cursor:\s*(url\("data:image\/svg\+xml,[^"]+"\))/g)]
    .map(m => `<span class="cursor-art" style="background-image:${escape(m[1])}"></span>`)
    .join('')
  return `<!doctype html>
<html lang="en" data-style="vintage" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web button gallery</title>
<style>${PAGE_CSS}</style>
<style>${vintageCss.replaceAll('url(/fonts/', 'url(fonts/')}</style>
<style>${RETRO_BUTTON_CSS}</style>
</head>
<body>
<h1>Web button gallery</h1>
<section id="profile"><h2>Profile card</h2><div class="card vt-window">${wallHtml(profile())}</div></section>
<section id="server"><h2>Server about panel</h2><div class="card vt-window">${wallHtml(server(1_234))}</div></section>
<section id="all"><h2>Every web button in every style</h2>
<table><thead><tr><th scope="col">Read as</th>${STYLES.map(s => `<th scope="col">${s}</th>`).join('')}</tr></thead>
<tbody>
${rows}
</tbody></table></section>
<section id="controls"><h2>Vintage controls</h2>${CONTROLS}${cursors}</div></section>
</body>
</html>
`
}

export interface Variant {
  name: string
  theme: 'dark' | 'light'
  forced: boolean
  textZoom: 1 | 2
}

export const VARIANTS: Variant[] = (['dark', 'light'] as const).flatMap(theme => [
  { name: theme, theme, forced: false, textZoom: 1 as const },
  { name: `${theme}-forced-colors`, theme, forced: true, textZoom: 1 as const },
  { name: `${theme}-text-200`, theme, forced: false, textZoom: 2 as const },
])

export interface Measured {
  label: string
  width: number
  height: number
  // The button scrolls, or a part of it reaches past its box.
  clipped: boolean
  font: string
  background: string
  color: string
  style: ButtonStyle
  outline: string
  outlineColor: string
  shadow: string
  // The emblem's own colors, or null without one.
  emblem: { color: string; background: string } | null
}

// What is wrong with a variant's buttons, as lines to print.
export function faults(
  v: Variant,
  buttons: Measured[],
  system?: { canvas: string; text: string }
): string[] {
  const out: string[] = []
  for (const b of buttons) {
    const size = `${b.width}x${b.height}`
    const exact = Math.abs(b.width - 88) < 0.01 && Math.abs(b.height - 31) < 0.01
    if (b.clipped) out.push(`${v.name}: ${b.label} clips its text`)
    if (v.textZoom === 1 && !exact) out.push(`${v.name}: ${b.label} is ${size}, not 88x31`)
    if (v.textZoom === 2 && exact)
      out.push(`${v.name}: ${b.label} did not grow with its text (${size})`)
    if (b.emblem && b.emblem.color === b.emblem.background)
      out.push(`${v.name}: ${b.label} has an emblem the color of its block`)
    if (b.font !== 'Silkscreen')
      out.push(`${v.name}: ${b.label} is set in ${b.font}, not Silkscreen`)
    if (v.forced && b.outline !== 'solid') out.push(`${v.name}: ${b.label} has no outline`)
    if (!v.forced && b.style === 'flat' && (b.outline !== 'solid' || b.outlineColor !== b.color))
      out.push(`${v.name}: ${b.label} has no outline in its text color`)
    if (v.forced && system && (b.background !== system.canvas || b.color !== system.text))
      out.push(`${v.name}: ${b.label} keeps its own colors`)
  }
  return out
}

const measure = () => {
  const round = (n: number) => Math.round(n * 100) / 100
  const probe = document.createElement('span')
  probe.style.cssText = 'background: Canvas; color: CanvasText'
  document.body.append(probe)
  const system = {
    canvas: getComputedStyle(probe).backgroundColor,
    text: getComputedStyle(probe).color,
  }
  probe.remove()
  const buttons = [...document.querySelectorAll<HTMLElement>('.retro-button')].map(el => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const past = [...el.querySelectorAll('span')].some(part => {
      const r = part.getBoundingClientRect()
      return (
        r.left < box.left - 0.5 ||
        r.right > box.right + 0.5 ||
        r.top < box.top - 0.5 ||
        r.bottom > box.bottom + 0.5
      )
    })
    const emblem = el.querySelector('.retro-emblem')
    const block = emblem ? getComputedStyle(emblem) : null
    return {
      label: el.getAttribute('aria-label') ?? '',
      width: round(box.width),
      height: round(box.height),
      clipped: past || el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
      font: style.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      background: style.backgroundColor,
      color: style.color,
      // Runs in the page, so it names the styles itself.
      style: (['flat', 'split'] as const).find(s => el.classList.contains(`retro-${s}`)) ?? 'bevel',
      outline: style.outlineStyle,
      outlineColor: style.outlineColor,
      shadow: style.boxShadow,
      emblem: block
        ? {
            color: block.color,
            background:
              block.backgroundColor === 'rgba(0, 0, 0, 0)'
                ? style.backgroundColor
                : block.backgroundColor,
          }
        : null,
    }
  })
  return { system, buttons, loaded: [...document.fonts].filter(f => f.status === 'loaded').length }
}

async function main(args: string[]) {
  const [out] = args
  if (!out) {
    console.error('usage: bun scripts/fx/retro_button_gallery.ts <out dir>')
    process.exit(2)
  }
  mkdirSync(join(out, 'fonts'), { recursive: true })
  for (const font of FONTS) copyFileSync(join(WEB, 'public/fonts', font), join(out, 'fonts', font))
  writeFileSync(
    join(out, 'index.html'),
    galleryHtml(readFileSync(join(WEB, 'app/vintage.css'), 'utf8'))
  )
  console.log(`wrote ${join(out, 'index.html')}`)
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
  const exe = findChrome(browsers)
  if (!exe) {
    console.log('no Chromium installed: no screenshots or measurements')
    return
  }
  const browser = await chromium.launch({ headless: true, executablePath: exe })
  const wrong: string[] = []
  for (const v of VARIANTS) {
    const context = await browser.newContext({
      viewport: { width: 900, height: 700 },
      colorScheme: v.theme,
      forcedColors: v.forced ? 'active' : 'none',
    })
    const page = await context.newPage()
    await page.goto(`file://${join(out, 'index.html')}`)
    await page.evaluate(
      ({ theme, zoom }) => {
        document.documentElement.dataset.theme = theme
        if (zoom !== 1) document.documentElement.style.fontSize = `${zoom * 100}%`
      },
      { theme: v.theme, zoom: v.textZoom }
    )
    await page.evaluate(() => document.fonts.ready)
    const { system, buttons, loaded } = await page.evaluate(measure)
    const found = faults(v, buttons, system)
    if (loaded < 2) found.push(`${v.name}: the bundled fonts did not load (${loaded})`)
    wrong.push(...found)
    await page.screenshot({ path: join(out, `${v.name}.png`), fullPage: true })
    console.log(`${v.name}: ${buttons.length} buttons, ${found.length} faults, ${v.name}.png`)
    await context.close()
  }
  await browser.close()
  for (const line of wrong) console.error(line)
  if (wrong.length) process.exit(1)
}

if (import.meta.main) await main(process.argv.slice(2))
