import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { InstanceTag, TAG_CLASSES, tagClass } from '../../components/account_tag'

const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
const block = (start: string) => {
  const from = css.indexOf(start)
  return from < 0 ? '' : css.slice(from, css.indexOf('\n}', from))
}
const THEMES = {
  dark: [block('@theme {')],
  light: [block(":root[data-theme='light'] {"), block('@theme {')],
}
// A color as a theme resolves it: its own override first, then the default.
const token = (theme: keyof typeof THEMES, name: string) => {
  for (const b of THEMES[theme]) {
    const hit = new RegExp(`--color-${name}: (#[0-9a-f]{6});`).exec(b)?.[1]
    if (hit) return hit
  }
  return ''
}

function luminance(hex: string) {
  const [r, g, b] = hex
    .match(/[0-9a-f]{2}/gi)!
    .map(x => parseInt(x, 16) / 255)
    .map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

test('all instance initials meet WCAG AA in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const on = luminance(token(theme, 'on-tag'))
    for (const cls of TAG_CLASSES)
      expect((on + 0.05) / (luminance(token(theme, cls.slice(3))) + 0.05)).toBeGreaterThanOrEqual(
        4.5
      )
    const html = renderToStaticMarkup(
      <div data-theme={theme}>
        <InstanceTag origin="https://alpha.test" name="Alpha" />
      </div>
    )
    expect(html).toContain(tagClass('https://alpha.test'))
    expect(html).toContain('text-on-tag')
    expect(html).toContain('>A</span>')
  }
})
