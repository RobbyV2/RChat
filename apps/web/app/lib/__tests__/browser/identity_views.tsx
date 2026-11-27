import { MarkdownMessage } from '../../../components/markdown_message'
import { ChatSourceProvider } from '../../../components/chat_source'
import { ServerDialogs } from '../../../components/server_dialogs'
import { IdentityEnrollment } from '../../../components/p2p/identity_enrollment'
import { addAccount, addIdentity, addInstance } from '../../client/book'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ContactRow } from '../../../components/p2p/p2p_home'
import { ConfigSyncSection } from '../../../components/config_sync'
import AppShell from '../../../[[...slug]]/app_shell'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { dmRoomId } from '../../p2p/dm'
import type { P2pApp } from '../../p2p/app/runtime'
import { P2pStore } from '../../p2p/db'
import type { ServerView } from '../../p2p/server'
import { CallBanner } from '../../../components/voice_grid'
import { client } from '../../client/client'
import { selectPageAccount } from '../../client/account_paths'
import { ContextMenu } from '../../../components/context_menu'
import { registerAppActions } from '../../actions'
import { AccountProvider } from '../../client/react'
import { P2pProvider, useP2p } from '../../client/p2p_react'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import type { Contact } from '../../p2p/contacts'
import { keyId, newKeyPair } from '../../p2p/keys'
import type { Me } from '../../types'
import { Secret } from '../../secret'

const me: Me = {
  username: 'sam',
  display_name: 'Reader',
  avatar_kind: 'identicon',
  avatar_color: null,
  banner_color: null,
  bio: null,
  is_site_admin: false,
  appear_offline: false,
  password_kind: 'text',
  servers: [{ name: 'garden', display_name: 'Garden', creator: null, is_admin: false }],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
}

const account = new AccountSession(
  new InstanceConnection(endpointsFrom('https://owner.test', null))
)
account.store.setState(s => ({ me, settings: { ...s.settings, p2p: true } }))
account.identities.setAccount('sam')
const main = account.identities.get()!
const sibling = account.identities.add('work')
const ik = keyId(newKeyPair().pk)
const self = keyId(newKeyPair().pk)
const room = 'overlapping-room'
for (const [app, label] of [
  [main, 'Personal contact'],
  [sibling, 'Work contact'],
] as const) {
  const contact: Contact = {
    ik,
    name: label,
    petname: null,
    profile: null,
    certs: [],
    revocations: [],
    state: 'incoming',
    ignored: false,
    intros: [],
    verified: false,
    verifiedAt: null,
    warning: null,
    notice: null,
    host: 'owner.test',
    added: 0,
    lastSeen: null,
  }
  app.useP2p.setState({
    enabled: true,
    me: self,
    contacts: [contact],
    rooms: {
      [room]: {
        id: room,
        peer: ik,
        seq: 1,
        pings: 0,
        unread: 0,
        lastTs: 0,
        count: 0,
        bytes: 0,
        full: false,
        fullWhy: undefined,
        peerFull: false,
        gap: false,
      },
    },
  })
}

function Pane() {
  const contact = useP2p(s => s.contacts[0])
  const dialog = useP2p(s => s.dialog?.kind)
  return (
    <>
      <output>{dialog ?? 'closed'}</output>
      {contact && <ContactRow c={contact} presence="offline" />}
    </>
  )
}
function Rail({ label }: { label: string }) {
  const servers = useP2p(s => s.layout.servers)
  return <output aria-label={label}>{JSON.stringify(servers)}</output>
}
function Fixture() {
  const [selected, setSelected] = useState(sibling)
  return (
    <AccountProvider session={account}>
      <section aria-label="Selected identity">
        <P2pProvider identity={selected}>
          <Pane />
        </P2pProvider>
      </section>
      <section aria-label="Main identity">
        <P2pProvider identity={main}>
          <Pane />
        </P2pProvider>
      </section>
      <P2pProvider identity={selected}>
        <ConfigSyncSection />
      </P2pProvider>
      <P2pProvider identity={sibling}>
        <Rail label="Work rail" />
      </P2pProvider>
      <P2pProvider identity={main}>
        <Rail label="Main rail" />
      </P2pProvider>
      <button onClick={() => setSelected(sibling)}>Show work</button>
      <button onClick={() => setSelected(main)}>Show main</button>
      <button onClick={() => account.identities.unregister('work')}>Remove work</button>
      <ContextMenu />
    </AccountProvider>
  )
}
function CallFixture() {
  return (
    <AccountProvider session={account}>
      <button onClick={() => account.identities.show(main)}>Show main call view</button>
      <button onClick={() => account.identities.show(sibling)}>Show work call view</button>
      <CallBanner />
    </AccountProvider>
  )
}

async function dockFixture(voice: boolean, background: boolean) {
  if (!background) client.shown = () => account
  const peerRoom = dmRoomId(self, ik)
  sibling.callRtc.active = () => true
  sibling.put.reader({ me: self, store: await P2pStore.create('dock-fixture') })
  const server = {
    id: 'server',
    name: 'Work server',
    me: 'join',
    owner: self,
    owners: [self],
    channels: [{ id: 'voice', name: 'Work channel', kind: 'voice' }],
    roles: [],
    members: [],
    chans: {},
    voice: {},
    perms: 0,
    rank: [0],
  } as unknown as ServerView
  sibling.useP2p.setState({
    servers: { server },
    home: false,
    voice: voice ? { room: 'server', ch: 'voice' } : null,
    call: voice
      ? null
      : {
          id: 'active',
          room: peerRoom,
          peer: ik,
          dir: 'out',
          state: 'active',
          video: false,
          since: 1,
          startedAt: 1,
        },
  })
  await client.calls.request(
    { account, identity: 'work', kind: voice ? 'p2p-voice' : 'p2p-call' },
    () => {}
  )
  const shown = client.shown()
  Object.assign(window, {
    confirmOverCall: () =>
      shown.store.getState().askConfirm({
        title: 'Confirm action',
        body: 'Continue?',
        confirm: 'Continue',
        action: () => {},
      }),
  })
  shown.store.setState(s => ({
    me,
    token: Secret.of('fixture'),
    bootstrap: async () => {},
    home: false,
    view: { kind: 'dm', dmId: 1 },
    settings: { ...s.settings, p2p: true },
  }))
  const router = {
    back() {},
    forward() {},
    refresh() {},
    push() {},
    replace() {},
    prefetch() {},
    bfcacheId: 'fixture',
  }
  return (
    <AppRouterContext.Provider value={router}>
      <AppShell />
    </AppRouterContext.Provider>
  )
}

// The export and file picker are independently releasable so switching identities
// exercises the real form at both asynchronous boundaries.
function exportFixture() {
  let finishExport: (() => void) | undefined
  let finishPicker: (() => void) | undefined
  const events: string[] = []
  const record = (name: string) => {
    events.push(name)
    document.body.dataset.exportEvents = JSON.stringify(events)
  }
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (value: string) => {
        document.body.dataset.copied = value
      },
    },
  })
  Object.defineProperty(window, 'showSaveFilePicker', {
    value: async () => {
      record('picker')
      await new Promise<void>(resolve => {
        finishPicker = resolve
      })
      return {
        createWritable: async () => ({
          write: async () => {},
          close: async () => record('saved'),
          abort: async () => {},
        }),
      }
    },
  })
  const prepare = (app: P2pApp, tag: string) => {
    app.useP2p.setState({ ik: self })
    app.p2pTransfer.filesSize = async () => 1024
    app.p2pTransfer.exportSection = async (_pass, _kdf, files) => {
      record('create:' + tag)
      await new Promise<void>(resolve => {
        finishExport = resolve
      })
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, [
        'encrypt',
      ])
      record('returned:' + tag)
      return {
        section: {
          v: 1,
          kdf: { alg: 'argon2id', m: 8, t: 1, p: 1 },
          salt: 'A'.repeat(22),
          iv: 'A'.repeat(16),
          ct: tag,
        },
        files: files ? { id: tag, key, salt: '' } : null,
      }
    }
    app.p2pTransfer.writeFiles = async key => {
      record('files:' + tag + ':' + key.id)
    }
  }
  prepare(main, 'main')
  prepare(sibling, 'work')
  account.identities.show(sibling)
  return (
    <AccountProvider session={account}>
      <ConfigSyncSection />
      <button onClick={() => account.identities.show(main)}>View main</button>
      <button onClick={() => account.identities.show(account.identities.get('work')!)}>
        View work
      </button>
      <button
        onClick={() => {
          account.identities.unregister('work')
          const app = account.identities.add('work')
          prepare(app, 'replacement')
          account.identities.show(app)
        }}
      >
        Replace work
      </button>
      <button onClick={() => finishExport?.()}>Finish export</button>
      <button onClick={() => finishPicker?.()}>Finish picker</button>
    </AccountProvider>
  )
}

async function enrollmentFixture() {
  client.show(account)
  await client.updateBook(book =>
    addIdentity(
      addAccount(
        addInstance(book, {
          origin: account.conn.origin,
          id: 'owner',
          name: 'Owner',
        }),
        account.conn.origin,
        { username: 'sam', display: null, avatar: null, identities: [], added: 1, connect: true },
        null
      ),
      account.conn.origin,
      'sam',
      { local: 'main', ik: self, name: 'Main', added: 1, background: true }
    )
  )
  return (
    <AccountProvider session={account}>
      <IdentityEnrollment
        account={account}
        cancel={() => {
          document.body.dataset.finished = 'yes'
        }}
      />
    </AccountProvider>
  )
}

registerAppActions()
const calls = new URLSearchParams(location.search).has('calls')
if (calls) {
  client.shown = () => account
  sibling.useP2p.setState({
    home: true,
    chat: { room, peer: ik, messages: [], more: false, loading: false, readSeq: 0, missed: [] },
    call: {
      id: 'work-call',
      room,
      peer: ik,
      dir: 'out',
      state: 'ringing',
      video: false,
      since: null,
      startedAt: 1,
    },
  })
}
function peerCodeFixture() {
  account.credentialTarget = me.username
  client.show(account, 'replace')
  let release: (() => void) | undefined
  let delay = false
  window.addEventListener('popstate', () => selectPageAccount(location.pathname, history.state))
  account.api.searchServers = async () => {
    document.body.dataset.searched = 'yes'
    return []
  }
  for (const app of [main, sibling]) {
    app.useP2p.setState({ account: 'sam', name: app.localId, status: 'online' })
    app.put.servers({
      voice: { back() {}, goodbye() {} },
      stop() {},
      async redeem() {
        if (delay)
          await new Promise<void>(resolve => {
            release = resolve
          })
        document.body.dataset.joined = app.localId
        return room
      },
      serverRooms: () => [],
      coOwnerAsks: () => [],
      transferAsks: () => [],
      invites: () => [],
    } as unknown as NonNullable<typeof app.servers>)
    app.p2pServer.peek = () =>
      ({ name: 'Test room' }) as NonNullable<ReturnType<typeof app.p2pServer.peek>>
    app.p2p.readCard = async () => {
      document.body.dataset.read = app.localId
      return null
    }
  }
  account.identities.show(main)
  Object.assign(window, {
    delayJoin: () => {
      delay = true
      delete document.body.dataset.joined
    },
    pendingJoin: () => !!release,
    finishJoin: () => {
      release?.()
      release = undefined
      delay = false
    },
    selectMain: () => account.identities.show(main),
    joinedRoom: () => sibling.useP2p.getState().server?.room,
    replaceWork: () => {
      account.identities.unregister('work')
      account.identities
        .add('work')
        .useP2p.setState({ account: 'sam', enabled: true, name: 'Replacement' })
    },
    viewedPeer: () => account.identities.viewed()?.localId,
  })
  return (
    <AccountProvider session={account}>
      <button
        onClick={() => account.store.getState().openDialog({ kind: 'add_server', tab: 'join' })}
      >
        Join a server
      </button>
      <P2pProvider identity={sibling}>
        <ChatSourceProvider
          value={{
            known: () => '',
            self,
            mine: () => false,
            user: () => me,
            people: () => [],
            toggleReaction: () => {},
            loadReactors: async () => [],
            openReactPicker: () => {},
          }}
        >
          {['rcp1.fixture', 'rci1.fixture'].map((content, i) => (
            <MarkdownMessage
              key={i}
              message={{
                id: 12,
                channel_id: null,
                dm_id: 1,
                thread_root_id: null,
                author: me,
                content,
                created_at: 1,
                reply_count: 0,
                media: null,
                embeds: [],
                kind: 'user',
                call: null,
              }}
            />
          ))}
        </ChatSourceProvider>
      </P2pProvider>
      <ServerDialogs />
    </AccountProvider>
  )
}
const root = createRoot(document.body.appendChild(document.createElement('main')))
const query = new URLSearchParams(location.search)
if (query.has('codes')) root.render(peerCodeFixture())
else if (query.has('enroll')) void enrollmentFixture().then(view => root.render(view))
else if (query.has('exports')) root.render(exportFixture())
else if (query.has('dock')) {
  void dockFixture(query.get('dock') === 'voice', query.has('background')).then(view =>
    root.render(view)
  )
} else root.render(calls ? <CallFixture /> : <Fixture />)
