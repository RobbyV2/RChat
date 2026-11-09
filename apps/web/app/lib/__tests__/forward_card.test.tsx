import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resetSessionCaches } from '../store'
import { ForwardCard } from '../../components/forwards'
import { msg, user } from './fixtures'

afterAll(resetSessionCaches)

const NAME = 'Bartholomew the Magnificent Third'

const card = () =>
  renderToStaticMarkup(
    <ForwardCard
      m={msg(9, {
        content: 'wha',
        author: user('carol'),
        forward: {
          author: { ...user('bart'), display_name: NAME },
          created_at: 3,
          source_id: 5,
          origin: null,
          dropped: null,
        },
      })}
      canDelete={false}
    />
  )

describe('forward card author', () => {
  test('a long name truncates beside its avatar; only the time wraps', () => {
    const html = card()
    const group = html.match(
      /<span data-forward-author="true" class="([^"]*)">([\s\S]*?)<\/span><time/
    )
    expect(group === null).toBe(false)
    const [, cls, inner] = group ?? []
    expect(cls.split(' ').includes('flex')).toBe(true)
    expect(cls.split(' ').includes('flex-wrap')).toBe(false)
    expect(cls.split(' ').includes('min-w-0')).toBe(true)
    expect(inner).toContain('title="View profile"')
    expect(inner).toContain(NAME)
  })
})
