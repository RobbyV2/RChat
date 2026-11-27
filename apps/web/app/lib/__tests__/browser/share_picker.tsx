import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ShareTarget } from '../../../components/share_target'
import { addAccount, addInstance } from '../../client/book'
import { client } from '../../client/client'
import { accountStorage, peerStorage } from '../../client/keys'
import { createSavedSession } from '../../client/saved_session'
import { blank } from '../../p2p/contacts'
import { dmRoomId } from '../../p2p/dm'
import { keyId, newKeyPair } from '../../p2p/keys'
import { p2pKey } from '../../p2p/app/store'
import type { ServerView } from '../../p2p/server'
import type { Me } from '../../types'
import { Secret } from '../../secret'

const self = keyId(newKeyPair().pk)
const contact = keyId(newKeyPair().pk)
const username = 'reader'
const shown = client.shown()
const cold = createSavedSession('https://cold.test', username)
const untouched = createSavedSession('https://untouched.test', username)
const accounts = [shown, cold, untouched]
let book = client.book.getState()
for (const account of accounts) {
  const { origin, host } = account.conn
  const identity = { local: 'main', ik: self, name: 'Hidden identity', added: 1, background: false }
  account.credentialTarget = username
  book = addAccount(
    addInstance(book, { origin, id: host, name: 'Hidden host' }),
    origin,
    { username, display: username, avatar: null, connect: false, added: 1, identities: [identity] },
    null
  )
  localStorage.setItem(accountStorage(account.conn).token(username), host)
  const flag = peerStorage(account.conn, username).scoped(p2pKey(username))
  account.identities.setRunning(new Set())
  localStorage.setItem(flag, JSON.stringify({ v: 1, on: true }))
  const dm = {
    id: 7,
    is_self: false,
    other: {
      username: 'peer',
      display_name: 'Hidden DM ' + host,
      avatar_kind: 'identicon' as const,
      avatar_color: null,
    },
  }
  const me: Me = {
    ...dm.other,
    username,
    display_name: 'Hidden reader',
    banner_color: null,
    bio: null,
    is_site_admin: false,
    appear_offline: false,
    password_kind: 'text',
    servers: [{ name: 'garden', display_name: 'Hidden garden', creator: null, is_admin: false }],
    servers_more: false,
    servers_cursor: null,
    dms: [dm],
    dms_more: false,
    dms_cursor: null,
  }
  account.api.me = async () => {
    await fetch(origin + '/api/me')
    return me
  }
  account.store.setSocket = allowed => {
    account.socketAllowed = allowed
  }
  account.store.resumeView = () => {}
  account.conn.ws.start = () => {}
  account.api.send = async () => Response.json([])
  account.identities.subscribe(() => {
    const peer = account.identities.get()
    if (!peer || peer.useP2p.getState().enabled) return
    // Admission opens the fixture's local peer data through the normal parked-slot path.
    peer.p2pAccount = async name => {
      if (!name) return
      peer.useP2p.setState({
        enabled: true,
        me: self,
        name: 'Hidden identity',
        account: username,
        contacts: [{ ...blank(contact, 0), state: 'mutual', name: 'Hidden contact ' + host }],
        servers: {
          garden: {
            id: 'garden',
            name: 'Hidden room',
            me: 'join',
            channels: [{ id: 'chat', name: 'Hidden channel', kind: 'text', send: true }],
            chans: {},
            members: [],
            roles: [],
            owners: [],
            voice: {},
          } as unknown as ServerView,
        },
      })
    }
    peer.p2pDm.openDm = async () => {
      const id = dmRoomId(self, contact)
      peer.useP2p.setState({
        chat: {
          room: id,
          peer: contact,
          messages: [],
          more: false,
          loading: false,
          readSeq: 0,
          missed: [],
        },
        rooms: {
          [id]: {
            id,
            peer: contact,
            seq: 0,
            unread: 0,
            pings: 0,
            lastTs: 0,
            count: 1,
            bytes: 1,
            full: true,
            fullWhy: 'bytes',
            peerFull: false,
            gap: false,
          },
        },
      })
    }
  })
  account.store.setState(s => ({
    settings: { ...s.settings, p2p: true, asset_uploads: true },
    loadInstance: async () => true,
    loadSettings: async () => {},
    openDm: async id => {
      account.store.setState({ view: { kind: 'dm', dmId: id } })
    },
  }))
  if (account === shown) {
    account.store.setState({ me, dms: [dm], token: Secret.of(host) })
    account.identities.setAccount(username)
  }
}
localStorage.setItem('rchat_book', JSON.stringify(book))
client.book.setState(book)
client.accounts.start()
client.device.setStreamer(true)
Object.assign(window, {
  inspectShare: () => ({
    shown: client.shown().conn.host,
    pending: accounts.map(a => a.store.getState().pending.d7?.file.name ?? null),
    peerFiles: accounts.map(
      a => Object.keys(a.identities.get()?.useP2p.getState().attaching ?? {}).length
    ),
  }),
})
function Fixture() {
  useEffect(() => {
    document.body.dataset.ready = 'true'
  }, [])
  return <ShareTarget />
}
createRoot(document.body.appendChild(document.createElement('main'))).render(<Fixture />)
