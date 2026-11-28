import { pictured } from '../people'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { minidenticon } from 'minidenticons'
import { AvatarPicker } from '../../components/avatar_picker'
import { UserAvatar } from '../../components/user_avatar'

const src = (svg: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`.replaceAll('&', '&amp;')

const noop = () => {}

describe('identicon avatar markup', () => {
  test('the default identicon is the plain minidenticon and has no inline background', () => {
    const html = renderToStaticMarkup(
      <UserAvatar person={pictured('carol', { kind: 'identicon', color: null }, 'own')} />
    )
    expect(html).toContain(`src="${src(minidenticon('carol', 95, 45))}"`)
    expect(html).not.toContain('style=')
    expect(html).toContain('bg-surface-container-highest')
  })

  test('a chosen background is painted and the ink is recolored to read on it', () => {
    const html = renderToStaticMarkup(
      <UserAvatar
        person={pictured('carol', { kind: 'identicon', color: '#FFFFFF' }, 'own')}
        size={40}
      />
    )
    expect(html).toContain('style="background:#ffffff"')
    expect(html).toContain(encodeURIComponent('fill="#c78605"'))
    expect(html).not.toContain(encodeURIComponent('hsl('))
    expect(html).toContain('width="40"')
  })

  test('a bad background falls back to the default identicon', () => {
    const html = renderToStaticMarkup(
      <UserAvatar person={pictured('carol', { kind: 'identicon', color: 'javascript:1' }, 'own')} />
    )
    expect(html).toContain(`src="${src(minidenticon('carol', 95, 45))}"`)
    expect(html).not.toContain('style=')
  })

  test('a color avatar shows its color', () => {
    const html = renderToStaticMarkup(
      <UserAvatar person={pictured('carol', { kind: 'color', color: '#123456' }, 'own')} />
    )
    expect(html).toContain('background:#123456')
    expect(html).not.toContain('<img')
  })
})

describe('avatar picker markup', () => {
  const picker = (kind: 'identicon' | 'color', background: string | null | undefined) =>
    renderToStaticMarkup(
      <AvatarPicker
        username="carol"
        kind={kind}
        color="#6750a4"
        onKind={noop}
        onColor={noop}
        {...(background === undefined ? {} : { background, onBackground: noop })}
      />
    )

  test('the identicon option previews the identicon background, not the avatar color', () => {
    const html = picker('identicon', '#ffffff')
    expect(html).toContain(encodeURIComponent('fill="#c78605"'))
    expect(html).toContain('style="background:#ffffff"')
    const plain = picker('identicon', null)
    expect(plain).toContain(`src="${src(minidenticon('carol', 95, 45))}"`)
  })

  test('an identicon gets swatches, a custom color and a default', () => {
    const html = picker('identicon', '#4f46b8')
    expect(html).toContain('aria-label="Identicon background"')
    expect(html).toContain('aria-label="Identicon background: Indigo"')
    expect(html).toContain('aria-label="Identicon background: custom color"')
    expect(html).toContain('Use default')
    const plain = picker('identicon', null)
    expect(plain).toContain('>Default<')
    expect(plain).not.toContain('Use default')
  })

  test('the background field shows only for identicons and only when it can be changed', () => {
    expect(picker('color', '#4f46b8')).not.toContain('Identicon background')
    const fixed = picker('identicon', undefined)
    expect(fixed).not.toContain('Identicon background')
    expect(fixed).toContain(`src="${src(minidenticon('carol', 95, 45))}"`)
  })
})
