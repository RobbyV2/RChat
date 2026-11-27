import { testSession } from './test_account'
import { createPeerFixture } from './peer_fixture'
import { home } from './home_instance'
const peerOwner = testSession(home)
const peerApp = createPeerFixture(peerOwner, 'reader')
const { p2pSearch, p2pServer, put, useP2p, peerTarget } = peerApp
import { expect, test } from 'bun:test'

const { endViewing, forgetViewing, useViewing } = peerOwner.viewing
import { Hub, ManualClock } from './p2p_net'
import { general, joinWithCode, makeMember, pump } from './p2p_server_net'
import { until } from './fixtures'

test('a peer receives the shared channel label and chooses before its local message history is read', async () => {
  const start = useP2p.getState()
  const service = peerApp.servers
  try {
    const clock = new ManualClock(),
      hub = new Hub()
    const author = await makeMember(hub, 'Gardener', clock)
    const viewer = await makeMember(hub, 'Reader', clock)
    const room = await author.servers.create('Garden'),
      id = general(author, room)
    await joinWithCode(clock, author, room, viewer)
    await author.servers.send(room, { ch: id, body: 'Sandcastle record' })
    await author.servers.editChannel(room, id, { sensitive: true })
    await pump(
      clock,
      () => viewer.servers.view(room)?.channels.find(c => c.id === id)?.sensitive === true,
      'shared label'
    )
    put.servers(viewer.servers)
    useP2p.setState({
      account: 'reader',
      server: { room, ch: null },
      servers: { [room]: viewer.servers.view(room)! },
      chat: null,
    })
    const history = viewer.servers.loadChannel
    let reads = 0
    viewer.servers.loadChannel = (...args) => {
      reads++
      return history.apply(viewer.servers, args)
    }
    try {
      const cancel = p2pServer.openChannel(id)
      expect(reads).toBe(0)
      useViewing.getState().prompt!.answer(false, false)
      expect(await cancel).toBe(false)
      expect(useP2p.getState().chat).toBeNull()
      expect(reads).toBe(0)
      const open = p2pServer.openChannel(id)
      useViewing.getState().prompt!.answer(true, false)
      expect(await open).toBe(true)
      await until(() => useP2p.getState().chat?.loading === false)
      expect(reads).toBe(1)
      const args = {
        q: 'sandcastle',
        from: '',
        ch: id,
        hasFile: false,
        beforeTs: null,
        afterTs: null,
      }
      const search = viewer.servers.search.bind(viewer.servers)
      await viewer.servers.indexing
      await p2pSearch.run(args, true)
      expect(useP2p.getState().search.hits.map(h => h.m.body)).toContain('Sandcastle record')
      let release!: () => void
      let scans = 0
      viewer.servers.search = async (...params) => {
        scans++
        await new Promise<void>(resolve => {
          release = resolve
        })
        return search(...params)
      }
      try {
        const pending = p2pSearch.run(args, true)
        forgetViewing(peerTarget(useP2p.getState(), room, id)!)
        expect(useP2p.getState().search.hits).toHaveLength(0)
        release()
        await pending
        await p2pSearch.run(args, true)
        expect(scans).toBe(1)
        expect(useP2p.getState().search.hits).toHaveLength(0)
      } finally {
        viewer.servers.search = search
        p2pSearch.close()
      }

      expect(useP2p.getState().chat).toBeNull()
    } finally {
      viewer.servers.loadChannel = history
    }
  } finally {
    put.servers(service)
    useP2p.setState(start, true)
    endViewing()
  }
}, 60_000)
