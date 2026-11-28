import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Name, NameArea, NameInput, NameSelect, useNameLabel } from '../../components/name'
import { MaskedWords } from '../../components/ui'
import {
  accountLabel,
  instanceAddress,
  instanceName,
  p2pName,
  personName,
  revealKeyOf,
  roomName,
  serverName,
  type NameValue,
} from '../names'
import { resetMasking, setMasking } from '../profanity'
import { useStore } from '../store'
import { shownUser } from '../people'
import type { UserRef } from '../types'
import { me, user } from './fixtures'

const shown = (username: string, over: Partial<UserRef> = {}) =>
  shownUser(user(username, over), null)

const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  Object.assign(initial, saved)
  resetMasking()
})

const masking = async () => {
  Object.assign(initial, { profanityOn: true, profanityReady: true, me: me('alice') })
  await setMasking(true, () => Promise.resolve(t => t.replace(/darn/g, '****')))
}

const html = renderToStaticMarkup
const words = (s: string) => s.split('data-masked-word').length - 1

describe('every kind is drawn in one marked element', () => {
  const kinds: [string, NameValue, string][] = [
    ['person', personName(shown('bob', { display_name: 'Bob' })), 'Bob'],
    ['server', serverName({ name: 'den', display_name: 'The Den' }), 'The Den'],
    ['room', roomName('Club'), 'Club'],
    ['instance', instanceName('Alpha'), 'Alpha'],
    ['address', instanceAddress('chat.a.test'), 'chat.a.test'],
    ['account', accountLabel('alice@chat.a.test'), 'alice@chat.a.test'],
    ['p2p', p2pName('Pat'), 'Pat'],
  ]
  for (const [kind, name, text] of kinds)
    test(kind, () => {
      expect(html(<Name of={name} />)).toBe(`<span class="streamer">${text}</span>`)
    })
})

describe('variants', () => {
  const ally = personName(shown('alice', { display_name: 'Ally' }))

  test('the name alone, placed and styled by the caller', () => {
    expect(html(<Name of={ally} as="p" place="min-w-0" look="truncate text-sm" />)).toBe(
      '<p class="streamer min-w-0 truncate text-sm">Ally</p>'
    )
    expect(html(<Name of={ally} color="#ff0000" before="@" />)).toBe(
      '<span style="color:#ff0000" class="streamer">@Ally</span>'
    )
  })

  test('with the username after it', () => {
    const pair = html(<Name of={ally} withUsername />)
    expect(pair.startsWith('<span class="streamer"><span class="')).toBe(true)
    expect(pair).toContain('<span class="min-w-0 truncate">Ally</span>')
    expect(pair).toContain(
      '<span class="max-w-full shrink-0 truncate text-on-surface-variant">(alice)</span>'
    )
    expect(pair.split('streamer').length).toBe(2)
  })

  test('fitted to a row, with the whole name in its title', () => {
    const fit = html(<Name of={ally} withUsername fit />)
    expect(fit.startsWith('<span title="Ally (alice)" class="streamer">')).toBe(true)
    expect(fit).toContain(
      '<span dir="auto" class="max-w-max min-w-0 shrink grow basis-16 truncate">'
    )
    Object.assign(initial, { streamer: true })
    expect(html(<Name of={ally} withUsername fit />).includes('title=')).toBe(false)
  })
})

describe('the viewer filter', () => {
  test('masks other names word by word and never the viewer own', async () => {
    await masking()
    const rude = personName(shown('darn', { display_name: 'oh darn' }))
    const drawn = html(<Name of={rude} withUsername titled />)
    expect(words(drawn)).toBe(2)
    expect(drawn).toContain('title="oh **** (****)"')
    const mine = personName(shown('alice', { display_name: 'darn alice' }))
    expect(words(html(<Name of={mine} withUsername />))).toBe(0)
    expect(words(html(<Name of={p2pName('darn', true)} />))).toBe(0)
    expect(words(html(<Name of={p2pName('darn')} />))).toBe(1)
    expect(words(html(<Name of={roomName('darn')} />))).toBe(1)
    expect(words(html(<Name of={instanceName('darn')} />))).toBe(1)
    expect(words(html(<Name of={instanceAddress('darn.test')} />))).toBe(0)
    expect(words(html(<Name of={accountLabel('darn@a.test')} />))).toBe(0)
  })

  test('a server the viewer made is their own text', async () => {
    await masking()
    Object.assign(initial, {
      me: me('alice', {
        servers: [
          {
            name: 'den',
            display_name: 'darn den',
            creator: 'alice',
            is_admin: true,
            banner_color: null,
            name_color: null,
            icon_image: null,
            icon_kind: 'identicon' as const,
            profiles_mode: 'all' as const,
            timed_out_remaining: null,
            timed_out_until: null,
          },
        ],
      }),
    })
    expect(words(html(<Name of={serverName({ name: 'den', display_name: 'darn den' })} />))).toBe(0)
    expect(words(html(<Name of={serverName({ name: 'pit', display_name: 'darn pit' })} />))).toBe(1)
  })

  test('a reveal of the pair shows the title unmasked', async () => {
    await masking()
    const rude = personName(shown('darn', { display_name: 'oh darn' }))
    const open = html(
      <MaskedWords open={[revealKeyOf(rude)]}>
        <Name of={rude} withUsername fit />
      </MaskedWords>
    )
    expect(open).toContain('title="oh darn (darn)"')
    expect(words(open)).toBe(0)
  })
})

describe('a label', () => {
  function Label({ name, generic }: { name: NameValue; generic?: string }) {
    return <i>{useNameLabel(name, generic)}</i>
  }

  test('names the thing, or only its kind in streamer mode', () => {
    const den = serverName({ name: 'den', display_name: 'The Den' })
    expect(html(<Label name={den} />)).toBe('<i>The Den</i>')
    Object.assign(initial, { streamer: true })
    expect(html(<Label name={den} />)).toBe('<i>Server</i>')
    expect(html(<Label name={den} generic="A server" />)).toBe('<i>A server</i>')
  })
})

describe('a field that holds a name', () => {
  test('is marked for streamer mode, with the plain field look by default', () => {
    const html = renderToStaticMarkup(<NameInput aria-label="Server" defaultValue="den" />)
    expect(html).toContain(' class="streamer ')
    expect(html).toContain('aria-label="Server"')
  })

  test('takes another look, and can be left unmarked', () => {
    expect(renderToStaticMarkup(<NameArea className="box" />)).toBe(
      '<textarea class="streamer box"></textarea>'
    )
    expect(
      renderToStaticMarkup(
        <NameSelect className="" aria-label="As">
          <option>a</option>
        </NameSelect>
      )
    ).toBe('<select aria-label="As" class="streamer"><option>a</option></select>')
    expect(renderToStaticMarkup(<NameInput named={false} className="box" />)).toBe(
      '<input class="box"/>'
    )
  })
})
