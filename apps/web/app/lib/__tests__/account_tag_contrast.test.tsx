import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { InstanceTag, TAG_COLORS, tagColor } from '../../components/account_tag'

function luminance(hex: string) {
  const [r, g, b] = hex
    .match(/[0-9a-f]{2}/gi)!
    .map(x => parseInt(x, 16) / 255)
    .map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

test('all instance initials meet WCAG AA in both themes', () => {
  for (const theme of ['light', 'dark']) {
    for (const bg of TAG_COLORS)
      expect((1 + 0.05) / (luminance(bg) + 0.05)).toBeGreaterThanOrEqual(4.5)
    const html = renderToStaticMarkup(
      <div data-theme={theme}>
        <InstanceTag origin="https://alpha.test" name="Alpha" />
      </div>
    )
    expect(html).toContain('background-color:' + tagColor('https://alpha.test'))
    expect(html).toContain('color:#fff')
    expect(html).toContain('>A</span>')
  }
})
