import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Covered } from '../../components/covered'
import { KeyAvatar } from '../../components/p2p/p2p_badge'
import { UserAvatar } from '../../components/user_avatar'
import { identityPerson, pictured } from '../people'

describe('text that streamer mode hides and that is not one name', () => {
  test('carries the mark before its own look', () => {
    expect(
      renderToStaticMarkup(
        <Covered what="about" as="p" look="text-xs break-words">
          Likes tea
        </Covered>
      )
    ).toBe('<p class="streamer text-xs break-words">Likes tea</p>')
    expect(renderToStaticMarkup(<Covered what="role">Mods</Covered>)).toBe(
      '<span class="streamer">Mods</span>'
    )
  })

  test('a part that needs hiding only sometimes is left as it is when it does not', () => {
    expect(
      renderToStaticMarkup(
        <Covered what="value" on={false} look="truncate">
          12
        </Covered>
      )
    ).toBe('<span class="truncate">12</span>')
    expect(
      renderToStaticMarkup(
        <Covered what="value" on={false}>
          12
        </Covered>
      )
    ).toBe('<span>12</span>')
  })
})

describe("a picture that is the viewer's own, outside a chat", () => {
  const marked = (html: string) => /^<(img|span)[^>]* class="streamer /.test(html)

  test('an account picture carries the mark only when asked to', () => {
    for (const kind of ['identicon', 'color'] as const) {
      const person = pictured('ann', { kind, color: null }, 'own')
      expect(marked(renderToStaticMarkup(<UserAvatar person={person} covered />))).toBe(true)
      expect(renderToStaticMarkup(<UserAvatar person={person} />)).not.toContain('streamer')
    }
  })

  test('a key picture too', () => {
    const person = identityPerson('k'.repeat(43), 'own')
    expect(marked(renderToStaticMarkup(<KeyAvatar person={person} covered />))).toBe(true)
    expect(renderToStaticMarkup(<KeyAvatar person={person} />)).not.toContain('streamer')
  })
})
