import { describe, test } from 'bun:test'
import { altsEdit } from '../alt_text'
import { Hub, ManualClock } from './p2p_net'
import { joinWithCode, makeMember, pump } from './p2p_server_net'

describe('image descriptions between devices', () => {
  test('a description sent with an image, then changed by an edit, reaches the other member', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Pictures')
    await joinWithCode(clock, a, room, b)
    const ch = a.servers.view(room)!.channels[0].id
    const { hashBytes } = await import('../p2p/hashing')
    const data = new Uint8Array(2000).fill(7)
    const h = await hashBytes(data)
    await a.dms.blobs.putOwn(new Blob([data as BlobPart]), h)
    const att = {
      h: h.h,
      size: h.size,
      blocks: h.blocks.length,
      name: 'cat.png',
      mime: 'image/png',
    }
    await a.servers.send(room, { ch, body: 'look', att: [{ ...att, alt: 'A cat' }] })
    const seen = async () =>
      (await b.servers.loadChannel(room, ch)).messages.find(m => m.body === 'look')?.att[0]?.alt
    await pump(clock, async () => (await seen()) === 'A cat', 'b sees the description')
    const sent = (await a.servers.loadChannel(room, ch)).messages.find(m => m.body === 'look')!
    await a.servers.edit(room, sent.id, 'look', altsEdit(att.h, 'A sleepy cat'))
    await pump(clock, async () => (await seen()) === 'A sleepy cat', 'b sees the new one')
    await a.servers.edit(room, sent.id, 'look again', altsEdit(att.h, '  '))
    await pump(clock, async () => (await seen()) === undefined, 'b sees it removed')
  })
})
