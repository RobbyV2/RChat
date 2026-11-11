import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownMessage } from '../../components/markdown_message'
import { resetSessionCaches, useStore } from '../store'
import { me, msg } from './fixtures'
import fixture from './fixtures/spoilers.json'
import { viewProse } from './fx_view_reader'

// `fx_view_reader.ts` reads a message with the view's spoiler pass (`hideSpoilers`). This test
// renders the real view and fails when the two read it differently, for example when the view
// gains a plugin that changes what it shows: give `fx_view_reader.ts` the same plugin.

// Spoilers and code blocks, and what the renderer adds around footnotes (the reference number,
// the "Footnotes" heading and the back links), which is no prose of the message.
const HIDDEN =
  /\sdata-(?:spoiler|spoiler-link|code-block|footnote-ref|footnote-backref)=|\sid="footnote-label"/
const VOID = new Set(['br', 'hr', 'img', 'input'])
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
}

// The text the rendered view shows as prose: everything outside spoilers, code and quotes.
const shownText = (html: string) => {
  const out: string[] = []
  const open: boolean[] = []
  let hidden = 0
  const parts = html.matchAll(/<(\/?)([a-z][a-z0-9]*)((?:"[^"]*"|[^">])*)>|([^<]+)/g)
  for (const [, close, tag, attrs, text] of parts) {
    if (text !== undefined) {
      if (!hidden) out.push(text.replace(/&(?:amp|lt|gt|quot|#x27);/g, e => ENTITIES[e]))
    } else if (close) {
      if (open.pop()) hidden -= 1
    } else if (!VOID.has(tag) && !attrs.endsWith('/')) {
      const hide = HIDDEN.test(attrs) || tag === 'code' || tag === 'blockquote'
      open.push(hide)
      if (hide) hidden += 1
    }
  }
  return out.join('')
}

const squash = (s: string) => s.replace(/\s+/g, '')

// Markup that crosses or nests with the markers: the cases the two passes are most likely to
// read differently.
const NESTING = [
  '**||secret**||',
  '*||secret*||',
  '||a **b|| c**',
  '||a *b|| c*',
  '**||bold||**',
  '||**bold** and _it_||',
  '~~||gone~~||',
  '||a|| **b ||c|| d** ||e||',
  '||a **b|| c ||d** e||',
  '**a ||b** c|| d ||e||',
  '- ||a\n- b||',
  '# ||a\nb||',
  '[||a](https://a.example/)||',
]

const TEXTS = [
  ...new Set([...fixture.spoilers.map(c => c.text), ...fixture.links.map(c => c.text), ...NESTING]),
]

const initial = useStore.getInitialState()
const saved = { ...initial }

describe('the view reader', () => {
  beforeEach(() => {
    Object.assign(initial, {
      me: me('alice'),
      settings: { ...saved.settings, asset_previews: false },
    })
  })

  afterEach(() => {
    Object.assign(initial, saved)
    resetSessionCaches()
  })

  test('reads the test html', () => {
    expect(
      shownText(
        '<p>a <span data-spoiler="hidden"><span>b</span></span> c <code>d</code> &amp; e<br/></p>'
      )
    ).toBe('a  c  & e')
    expect(
      shownText(
        '<p>a<sup><a data-footnote-ref="true" href="#fn-x">1</a></sup> b</p><section data-footnotes="true">' +
          '<h2 id="footnote-label">Footnotes</h2><ol><li id="fn-x"><p>note <a data-footnote-backref="">↩</a></p></li></ol></section>'
      )
    ).toBe('a bnote ')
  })

  test('shows what the message view shows, for every spoiler fixture', () => {
    expect(TEXTS.length).toBeGreaterThan(60)
    const drift: [string, string, string][] = []
    for (const text of TEXTS) {
      const html = renderToStaticMarkup(<MarkdownMessage message={msg(1, { content: text })} />)
      const view = squash(shownText(html))
      const copy = squash(viewProse(text))
      if (view !== copy) drift.push([text, view, copy])
    }
    expect(drift).toEqual([])
  })
})
