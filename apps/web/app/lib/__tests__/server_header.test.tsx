import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ServerHeader } from '../../components/server_header'
import { GEAR_CHIP_CSS } from '../server_colors'

const header = (bannerColor: string | null, preview = false) =>
  renderToStaticMarkup(
    <ServerHeader
      server="lounge"
      displayName="Lounge"
      bannerColor={bannerColor}
      nameColor={null}
      onSettings={() => {}}
      preview={preview}
    />
  )

describe('server header gear', () => {
  test('has no glow behind it', () => {
    for (const banner of [null, '#ffe8a3', '#262a33', '#4f46b8'])
      for (const preview of [false, true]) expect(header(banner, preview)).not.toContain('gradient')
  })

  test('sits on a theme chip on a banner', () => {
    expect(header('#ffe8a3')).toContain(`--gear-chip:${GEAR_CHIP_CSS}`)
    expect(header('#262a33', true)).toContain(`--gear-chip:${GEAR_CHIP_CSS}`)
  })

  test('on a banner its focus ring takes the banner text color', () => {
    for (const [banner, on] of [
      ['#ffe8a3', '#000000'],
      ['#4f46b8', '#ffffff'],
    ])
      for (const preview of [false, true]) {
        const html = header(banner, preview)
        expect(html).toContain(`--hdr-gear:${on}`)
        expect(html).toContain('focus-visible:outline-(--hdr-gear)')
        expect(html).not.toContain('focus-visible:outline-primary')
      }
  })

  test('is a plain icon button without a banner', () => {
    const html = header(null)
    expect(html).not.toContain('--gear-chip')
    expect(html).toContain('aria-label="Server settings"')
    expect(html).toContain('title="Server settings"')
    expect(html).toContain('focus-visible:outline-primary')
  })
})
