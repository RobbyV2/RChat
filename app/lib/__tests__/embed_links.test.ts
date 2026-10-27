import { describe, expect, test } from 'bun:test'
import { postedLinks, postedUrl, scrubUrl } from '../embed_links'

describe('embed links', () => {
  test('scrubs exactly like the server (embeds.rs scrubbed_urls_match_the_client)', () => {
    const cases: [string, string][] = [
      ['https://dl.example/f.zip?sig=abc&exp=9', 'https://dl.example/f.zip?exp=9'],
      ['https://site.example/page?code=123', 'https://site.example/page'],
      ['https://site.example/a?q=a+b&Key=k#x', 'https://site.example/a?q=a+b'],
      ['https://Site.Example/Path', 'https://site.example/Path'],
      ['https://site.example/a?q=%2F&x', 'https://site.example/a?q=%2F&x='],
    ]
    for (const [posted, stored] of cases) expect(scrubUrl(posted)).toBe(stored)
    expect(scrubUrl('not a url')).toBeNull()
  })

  test('the card links to the url as it was posted', () => {
    const content =
      'grab it https://dl.example/f.zip?sig=abc&exp=9. or https://site.example/page?code=1!'
    expect(postedLinks(content)).toEqual([
      'https://dl.example/f.zip?sig=abc&exp=9',
      'https://site.example/page?code=1',
    ])
    expect(postedUrl(content, 'https://dl.example/f.zip?exp=9')).toBe(
      'https://dl.example/f.zip?sig=abc&exp=9'
    )
    expect(postedUrl(content, 'https://site.example/page')).toBe('https://site.example/page?code=1')
    expect(postedUrl(content, 'https://other.example/')).toBe('https://other.example/')
  })
})
