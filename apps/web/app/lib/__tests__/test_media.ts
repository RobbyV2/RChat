import { createIceCache } from '../ice'
import { createHomeConnection } from '../instances'
import { P2pManager } from '../p2p'
import { createRelayBook } from '../relays'

export function createTestMedia(conn = createHomeConnection()) {
  const ice = createIceCache(conn)
  const relays = createRelayBook(ice)
  return { conn, ice, relays, createFileManager: () => new P2pManager(conn, ice, relays) }
}
