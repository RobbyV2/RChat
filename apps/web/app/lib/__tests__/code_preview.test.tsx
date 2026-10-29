import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeBlock, CodePreview } from '../../components/code_block'

const preview = (verified: boolean | undefined, note?: string) =>
  renderToStaticMarkup(
    <CodePreview
      filename="main.rs"
      size={20}
      lang="rust"
      file={{ text: 'fn main() {}\n', cut: false, verified }}
      plain={verified === false}
      note={note}
    />
  )

describe('CodePreview', () => {
  test('unverified files are plain text with a note', () => {
    const html = preview(false, 'Not verified, so shown as plain text')
    expect(html).toContain('Not verified, so shown as plain text')
    expect(html).toContain('fn main() {}')
    expect(html).toContain('<code>fn main() {}\n</code>')
  })

  test('no note for verified files', () => {
    expect(preview(true).includes('Not verified')).toBe(false)
  })
})

describe('CodeBlock', () => {
  test('untagged fences are labelled Text', () => {
    expect(renderToStaticMarkup(<CodeBlock code="hello" tag={null} />)).toContain('>Text<')
  })

  test('unknown tags keep their label', () => {
    expect(renderToStaticMarkup(<CodeBlock code="hello" tag="zzz" />)).toContain('>zzz<')
  })
})
