import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerField, fits } from '../../components/composer_field'
import { AccountProvider } from '../client/react'
import { P2pProvider } from '../client/p2p_react'
import { composer, type ComposerList } from '../place/composer'
import { featureAt, isUnsupported } from '../place/feature'
import { PlaceProvider } from '../place/react'
import type { RChatState } from '../store_types'
import type { View } from '../view'
import { msg } from './fixtures'
import { placeContract, type ContractWorld } from './helpers/place_contract'

// Ann's side with the conversation on screen and a thread open beside it, a draft in each, and
// what the side is asked recorded.
const seat = (world: ContractWorld, calls: unknown[][], list: ComposerList = 'main') => {
  const { place } = world.ann
  if (place.kind === 'hostedServer' || place.kind === 'hostedDm') {
    const view: View =
      place.kind === 'hostedServer'
        ? { kind: 'channel', server: world.server, channelId: 1 }
        : { kind: 'dm', dmId: world.dmId }
    const key = place.kind === 'hostedServer' ? 'c1' : `d${world.dmId}`
    const state = {
      view,
      panel: { kind: 'thread', root: msg(5) },
      drafts: { [key]: 'see you at noon', t5: 'in the thread' },
      replying: { t5: { message: msg(6) } },
      setDraft: (...a: unknown[]) => void calls.push(['draft', ...a]),
      noteTyping: (...a: unknown[]) => void calls.push(['typing', ...a]),
      editLast: (k: string) => {
        calls.push(['edit', k])
        return true
      },
      cancelReply: (k: string) => void calls.push(['cancel', k]),
    } as unknown as Partial<RChatState>
    world.ann.account.store.setState(state)
    Object.assign(world.ann.account.store.getInitialState(), world.ann.account.store.getState())
  } else {
    const ch = place.kind === 'p2pRoom' ? 'c1' : null
    const main = ch ? `${world.room}/${ch}` : world.room
    const thread = `${main}#e5`
    const state = {
      chat: { room: world.room, ch },
      thread: { room: world.room, ch, root: 'e5' },
      drafts: { [main]: 'see you at noon', [thread]: 'in the thread' },
      replying: { room: thread, id: 'e6' },
    }
    place.app.useP2p.setState(state as never)
    Object.assign(place.app.useP2p.getInitialState(), state)
    Object.assign(place.app.p2pDm, {
      setDraft: (...a: unknown[]) => void calls.push(['draft', ...a]),
      typing: (...a: unknown[]) => void calls.push(['typing', ...a]),
      typingEvery: () => 4_000,
      editLast: (k: string) => {
        calls.push(['edit', k])
        return true
      },
      cancelReply: () => void calls.push(['cancel']),
    })
  }
  const here = featureAt(composer, place)
  if (isUnsupported(here)) throw new Error(here.line)
  return here.at(list)
}

placeContract(composer, (kind, world) => {
  const hosted = kind === 'hostedServer' || kind === 'hostedDm'
  const mainKey = () =>
    hosted
      ? kind === 'hostedServer'
        ? 'c1'
        : `d${world().dmId}`
      : kind === 'p2pRoom'
        ? `${world().room}/c1`
        : world().room
  const threadKey = () => (hosted ? 't5' : `${mainKey()}#e5`)

  test('each list of the place has its own draft', () => {
    const main = seat(world(), [])
    const state = main.state.get()
    expect(main.state.get()).toBe(state)
    expect([state.key, state.text, state.replying]).toEqual([mainKey(), 'see you at noon', false])
    expect(state.max).toBeGreaterThan(0)
    const thread = seat(world(), [], 'thread').state.get()
    expect([thread.key, thread.text, thread.replying]).toEqual([threadKey(), 'in the thread', true])
  })

  test('the draft, the last edit and the reply change on the side of the place', () => {
    const calls: unknown[][] = []
    const thread = seat(world(), calls, 'thread')
    thread.setText('later')
    expect(thread.editLast()).toBe(true)
    thread.cancelReply()
    expect(calls).toEqual([
      ['draft', threadKey(), 'later'],
      ['edit', threadKey()],
      hosted ? ['cancel', threadKey()] : ['cancel'],
    ])
  })

  test('typing is said as often as the place wants it', () => {
    const calls: unknown[][] = []
    const main = seat(world(), calls)
    const key = mainKey()
    main.typing(key, true)
    main.typing(key, true)
    main.typing(key, false)
    expect(calls).toEqual(
      hosted
        ? [
            ['typing', key, true],
            ['typing', key, true],
            ['typing', key, false],
          ]
        : [
            ['typing', key, true],
            ['typing', key, false],
          ]
    )
  })

  test('a text fits by its count and, between identities, by its size', () => {
    const main = seat(world(), [])
    const { max } = main.state.get()
    expect(fits(main, 'a'.repeat(max), max)).toBe(true)
    expect(fits(main, 'a'.repeat(max + 1), max)).toBe(false)
  })

  test('one field draws either side', () => {
    const main = seat(world(), [])
    const { ann } = world()
    const html = renderToStaticMarkup(
      <AccountProvider session={ann.account}>
        <P2pProvider identity={ann.app}>
          <PlaceProvider place={ann.place}>
            <ComposerField
              compose={main}
              listKey={null}
              placeholder="Message"
              slowLeft={0}
              bar={null}
              onSend={() => {}}
            />
          </PlaceProvider>
        </P2pProvider>
      </AccountProvider>
    )
    expect(html).toContain('see you at noon')
    expect(html).toContain('aria-label="Emoji"')
    expect(html).toContain('aria-label="Send"')
  })
})
