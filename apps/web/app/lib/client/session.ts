import { createApiDoc } from '../api_console'
import { createTextPreviews } from '../code'
import { createHomeStore } from '../home_store'
import { createIceCache, ice as homeIce } from '../ice'
import { createInboxSources } from '../inbox_source'
import { createMediaSrc } from '../media_src'
import { createPalettePrefs } from '../palette_store'
import { createPaletteIndexer } from '../palette_sync'
import { P2pManager, p2p as homeFiles } from '../p2p'
import { createRelayBook, relayBook as homeRelays } from '../relays'
import { createInviteCache } from '../remote_invite'
import { createRtc, rtc as homeRtc } from '../rtc'
import { createViewing } from '../viewing'
import { createChatStore } from '../store'
import { sessionLifetime } from '../slices/ctx'
import { lookup, shareOrigin, type InstanceConnection } from '../instances'
import { client } from './client'
import { KeyScope } from './keys'

export type AccountId = string

export class AccountSession {
  readonly renderKey = client.nextSessionKey()
  readonly textPreviews = createTextPreviews()
  readonly keys: KeyScope
  readonly lifetime = sessionLifetime()
  readonly store: ReturnType<typeof createChatStore>
  readonly home: ReturnType<typeof createHomeStore>
  readonly palettePrefs: ReturnType<typeof createPalettePrefs>
  readonly indexer: ReturnType<typeof createPaletteIndexer>
  readonly inbox: ReturnType<typeof createInboxSources>
  readonly apiDoc: ReturnType<typeof createApiDoc>
  readonly ice: ReturnType<typeof createIceCache>
  readonly relays: ReturnType<typeof createRelayBook>
  readonly rtc: ReturnType<typeof createRtc>
  readonly files: P2pManager
  readonly media: ReturnType<typeof createMediaSrc>
  readonly invites: ReturnType<typeof createInviteCache>

  constructor(
    readonly conn: InstanceConnection,
    readonly viewing = createViewing(conn),
    readonly discovery = lookup()
  ) {
    this.keys = new KeyScope(conn, () => this.username)
    this.ice = this.isHome ? homeIce : createIceCache(conn)
    this.rtc = this.isHome ? homeRtc : createRtc(conn, this.ice)
    this.relays = this.isHome ? homeRelays : createRelayBook(this.ice)
    this.files = this.isHome ? homeFiles : new P2pManager(conn, this.ice, this.relays)
    this.media = createMediaSrc(conn, this.lifetime.live)
    this.invites = createInviteCache(this)
    this.store = createChatStore(this)
    this.home = createHomeStore(this)
    this.palettePrefs = createPalettePrefs(this)
    this.indexer = createPaletteIndexer(this)
    this.inbox = createInboxSources(this)
    this.apiDoc = createApiDoc(this)
    this.store.bindMedia()
    client.attach(this)
  }

  get isHome() {
    return this.conn.isHome
  }

  disposeSideStores() {
    this.indexer.dispose()
    this.palettePrefs.dispose()
    this.home.dispose()
    this.inbox.dispose()
    this.apiDoc.dispose()
    this.media.clear()
    this.files.dispose()
    this.rtc.dispose()
    this.relays.dispose()
    this.ice.dispose()
  }

  private get username() {
    return this.store.getState().me?.username ?? null
  }

  get id(): AccountId {
    return `${this.username ?? '~guest'}@${this.conn.host}`
  }

  get shareOrigin() {
    return shareOrigin(undefined, undefined, this.conn)
  }

  get api() {
    return this.conn.api
  }
}
