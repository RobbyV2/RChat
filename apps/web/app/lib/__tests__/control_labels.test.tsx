import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { X } from 'lucide-react'
import { Button, IconButton, SwitchRow } from '../../components/controls'
import {
  labelWith,
  nameLabel,
  notAName,
  personName,
  unnamed,
  type Label,
  type NameView,
} from '../names'
import { shownUser } from '../people'
import { user as account } from './fixtures'

const view = (streamer: boolean): NameView => ({
  streamer,
  mask: text => text.replace(/Darn/g, '****'),
  own: false,
})
const user = shownUser(account('dee', { display_name: 'Darn Dee' }), null)

describe('a control label', () => {
  test('takes the app words as written', () => {
    const on = Math.random() > 2
    const html = renderToStaticMarkup(
      <>
        <IconButton icon={X} label="Close" onClick={() => {}} />
        <IconButton icon={X} label={on ? 'Open' : 'Close'} tooltip="Close it" />
        <Button label="Send">Send</Button>
      </>
    )
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('title="Close it"')
  })

  test('takes a name only through its label, which applies the filter and streamer mode', () => {
    const name = personName(user)
    const label = (streamer: boolean) =>
      renderToStaticMarkup(
        <IconButton
          icon={X}
          label={labelWith`Remove ${nameLabel(name, view(streamer), 'this person')}`}
        />
      )
    expect(label(false)).toContain('aria-label="Remove **** Dee"')
    expect(label(true)).toContain('aria-label="Remove this person"')
  })

  test('refuses a written or computed string', () => {
    const display: string = user.display_name
    const count = 3
    const words: string = 'Close'
    const refused = () => (
      <>
        {/* @ts-expect-error: a person's name is not a label */}
        <IconButton icon={X} label={user.display_name} />
        {/* @ts-expect-error: nor a line built around one */}
        <IconButton icon={X} label={`Remove ${display}`} />
        {/* @ts-expect-error: nor a tooltip */}
        <IconButton icon={X} label="Remove" tooltip={display} />
        {/* @ts-expect-error: nor a switch's hint */}
        <SwitchRow checked={false} label="Mute" hint={`For ${display}`} />
        {/* @ts-expect-error: a computed string is refused even with no name in it */}
        <Button title={words}>Close</Button>
      </>
    )
    // @ts-expect-error: labelWith takes labels and counts only
    void labelWith`Message ${display}`
    void labelWith`Remove option ${count}`
    expect(typeof refused).toBe('function')
  })

  test('text that is not a name is marked so where it is made', () => {
    const file: Label = notAName('clip.mp4')
    const kept: Label = unnamed('a contact')
    expect<string>(labelWith`Save ${file}`).toBe('Save clip.mp4')
    expect<string>(kept).toBe('a contact')
  })
})
