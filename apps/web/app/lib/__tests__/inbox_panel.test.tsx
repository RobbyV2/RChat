import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { resetSessionCaches } from '../store'
import { InboxAction, InboxPanel } from '../../components/inbox'

afterAll(resetSessionCaches)

describe('inbox markup', () => {
  test('role names are blurred in streamer mode like other names', () => {
    const html = renderToStaticMarkup(
      <InboxAction entry={{ kind: 'role', role: 'Crew', emoji: null }} />
    )
    expect(html).toContain('mentioned @<span class="streamer">Crew</span>')
    expect(
      renderToStaticMarkup(<InboxAction entry={{ kind: 'everyone', role: null, emoji: null }} />)
    ).toContain('mentioned @everyone')
  })

  test('the tabs control a labelled tab panel', () => {
    const html = renderToStaticMarkup(<InboxPanel />)
    const panel = /<div id="([^"]+)" role="tabpanel" aria-labelledby="([^"]+)"/.exec(html)
    expect(panel === null).toBe(false)
    const [, panelId, labelledBy] = panel ?? []
    expect(html).toContain(`id="${labelledBy}" type="button" role="tab" aria-selected="true"`)
    expect(html.match(new RegExp(`aria-controls="${panelId}"`, 'g'))).toHaveLength(2)
    expect(html).toContain('tabindex="-1"')
  })
})
