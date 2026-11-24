import { allowsAccountOrigin } from './hosted_policy'
import {
  clientOnly,
  createHomeConnection,
  defaultEndpoints,
  endpointsFrom,
  InstanceConnection,
  InstanceError,
  normalizeOrigin,
  pageEndpoints,
  readLocal,
  rememberHome,
  rememberInstance,
  type Endpoints,
} from '../instances'
import type { Book } from './book'
import { storedCredential } from './credentials'
import { accountStorage } from './keys'
import { normalizeHost } from '../qualified'
import type { InstanceInfo } from '../types'

export class InstanceRegistry {
  private others = new Map<string, InstanceConnection>()

  constructor(
    readonly home: InstanceConnection,
    private defaults: () => Endpoints | null
  ) {}

  list() {
    return [this.home, ...this.others.values()]
  }

  get(origin: string) {
    const key = normalizeOrigin(origin)
    if (!key) return null
    return key === this.home.origin ? this.home : (this.others.get(key) ?? null)
  }

  byHost(host: string) {
    const want = normalizeHost(host)
    return this.list().find(c => c.host === want) ?? null
  }

  isHome(originOrHost: string) {
    const origin = normalizeOrigin(originOrHost)
    return origin === this.home.origin || normalizeHost(originOrHost) === this.home.host
  }

  add(origin: string, info: InstanceInfo | null = null) {
    const key = normalizeOrigin(origin)
    if (!key) throw new InstanceError('Not an instance address')
    const found = this.get(key)
    if (found) {
      if (info) found.info = info
      return found
    }
    const conn = new InstanceConnection(endpointsFrom(key, info), info)
    this.others.set(key, conn)
    return conn
  }

  remove(origin: string) {
    const key = normalizeOrigin(origin)
    const conn = key ? this.others.get(key) : undefined
    if (!key || !conn) return false
    conn.ws.stop()
    this.others.delete(key)
    return true
  }

  setHome(origin: string, info: InstanceInfo | null) {
    const key = normalizeOrigin(origin)
    if (!key) throw new InstanceError('Not an instance address')
    const defaults = this.defaults()
    const isDefault = key === defaults?.origin
    this.home.ws.stop()
    this.home.retarget(isDefault ? defaults : endpointsFrom(key, info), info, isDefault)
    this.others.delete(key)
    return this.home
  }

  selectHome(origin: string, info: InstanceInfo, connection: InstanceConnection) {
    if (connection !== this.home) {
      connection.retarget(endpointsFrom(origin, info), info, false)
      accountStorage(connection)
      rememberInstance(origin, info)
      return connection
    }
    const selected = this.setHome(origin, info)
    accountStorage(selected)
    rememberHome(selected, info)
    return selected
  }
}

export function createInstanceRegistry(book: Book) {
  let home = createHomeConnection()
  if (!allowsAccountOrigin(home.origin))
    home = new InstanceConnection(pageEndpoints(), null, true, true)
  // An old selected address can outlive the login that selected it.
  if (
    clientOnly() &&
    !home.isDefault &&
    !storedCredential(home, book) &&
    readLocal(accountStorage(home).key('rchat_guest')) !== '1'
  )
    home = new InstanceConnection(pageEndpoints(), null, true, true)
  return new InstanceRegistry(home, defaultEndpoints)
}
