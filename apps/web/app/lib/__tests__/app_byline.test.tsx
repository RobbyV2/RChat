import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppByline } from '../../components/app_preview'

test('an app author always shows as unverified beside the name', () => {
  const html = renderToStaticMarkup(<AppByline author={'Writer '.repeat(40)} />)
  expect(html).toContain('Unverified')
  expect(/data-app-unverified="true" [^>]*class="[^"]*shrink-0/.test(html)).toBe(true)
})
