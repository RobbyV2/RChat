import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Name, useNameLabel } from '../../components/name'
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
import { setMasking } from '../profanity'
import { useStore } from '../store'
import { me, user } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(async () => {
  Object.assign(initial, saved)
  await setMasking(false)
})

const masking = async () => {
  Object.assign(initial, { profanityOn: true, profanityReady: true, me: me('alice') })
  await setMasking(true, () => Promise.resolve(t => t.replace(/darn/g, '****')))
}

const html = renderToStaticMarkup
const words = (s: string) => s.split('data-masked-word').length - 1

describe('every kind is drawn in one marked element', () => {
  const kinds: [string, NameValue, string][] = [
    ['person', personName(user('bob', { display_name: 'Bob' }), 'shown'), 'Bob'],
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
  const ally = personName(user('alice', { display_name: 'Ally' }), 'shown')

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
    expect(fit).toContain('<span dir="auto" class="max-w-max min-w-0 flex-[1_1_4rem] truncate">')
    Object.assign(initial, { streamer: true })
    expect(html(<Name of={ally} withUsername fit />).includes('title=')).toBe(false)
  })
})

describe('the viewer filter', () => {
  test('masks other names word by word and never the viewer own', async () => {
    await masking()
    const rude = personName(user('darn', { display_name: 'oh darn' }), 'shown')
    const drawn = html(<Name of={rude} withUsername titled />)
    expect(words(drawn)).toBe(2)
    expect(drawn).toContain('title="oh **** (****)"')
    const mine = personName(user('alice', { display_name: 'darn alice' }), 'shown')
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
          },
        ],
      }),
    })
    expect(words(html(<Name of={serverName({ name: 'den', display_name: 'darn den' })} />))).toBe(0)
    expect(words(html(<Name of={serverName({ name: 'pit', display_name: 'darn pit' })} />))).toBe(1)
  })

  test('a reveal of the pair shows the title unmasked', async () => {
    await masking()
    const rude = personName(user('darn', { display_name: 'oh darn' }), 'shown')
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
