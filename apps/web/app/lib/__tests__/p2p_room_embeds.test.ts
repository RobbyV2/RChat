import { describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import { joinWithCode, makeMember, pump } from './p2p_server_net'

describe('embeds in a P2P room', () => {
  test('a message with an embed shows it to the other member', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Cards')
    await joinWithCode(clock, a, room, b)
    const ch = a.servers.view(room)!.channels[0].id
    const card = { title: 'Card', description: 'Shown to Bob' }
    await a.servers.send(room, { ch, body: 'see', emb: [card] })
    const seen = async () =>
      (await b.servers.loadChannel(room, ch)).messages.find(m => m.body === 'see')?.emb
    await pump(clock, async () => (await seen())?.length === 1, 'b sees the card')
    expect(await seen()).toEqual([card])
  })
})
