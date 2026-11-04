import { P2pStore } from '../db'
import { webLeaderDeps } from '../leader'
import {
  alreadyImported,
  applyImport,
  exportP2p,
  exportP2pWithFiles,
  filesSize,
  IMPORTED_HERE,
  importFiles,
  importKind,
  summarize,
  unlockP2p,
  unlockP2pWithFiles,
  writeFiles,
  TransferError,
  type FilesHead,
  type FilesKey,
  type Dump,
  type ImportKind,
  type Imported,
  type Kdf,
  type P2pSection,
  type Summary,
} from '../transfer'
import {
  useP2p,
  store,
  reader,
  node,
  readImports,
  rememberImport,
  leader,
  gen,
  writeOn,
} from './store'
import { dbFor, stopNode, boot, run } from './account'

// ----- Device move -----

export const ELSEWHERE_IMPORT = 'P2P is open in another tab. Use it here first.'

const errText = (e: unknown) =>
  e instanceof TransferError || e instanceof Error ? e.message : String(e)

// The database of this account, for a moment: the running node's, or opened just for this.
const withDb = async <T>(fn: (s: P2pStore) => Promise<T>): Promise<T> => {
  const username = useP2p.getState().account
  if (!username) throw new Error('Sign in first')
  const live = store ?? reader?.store
  if (live && !live.closed) return fn(live)
  const s = await P2pStore.open(dbFor(username))
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

// Without `databases()`, opening without a version and aborting the upgrade of a database that
// didn't exist leaves nothing behind.
const probeDb = (name: string) =>
  new Promise<boolean>(resolve => {
    const req = indexedDB.open(name)
    req.onupgradeneeded = () => {
      if (req.transaction) req.transaction.abort()
      resolve(false)
    }
    req.onsuccess = () => {
      req.result.close()
      resolve(true)
    }
    req.onerror = () => resolve(false)
  })

const hasDb = async (name: string) => {
  try {
    const list = await indexedDB.databases?.()
    return list ? list.some(d => d.name === name) : await probeDb(name)
  } catch {
    return true
  }
}

export interface Unlocked {
  dump: Dump
  summary: Summary
  kind: ImportKind
  // This identity already took this file in: importing changes nothing.
  already: boolean
  // The files that follow the data in the `.rchat` file, and their key.
  files: { blob: Blob; key: FilesKey } | null
}

// A `.rchat` file's files part: everything after its first line.
export interface FilesPart {
  blob: Blob
  head: FilesHead
}

export const p2pTransfer = {
  // Bytes of the complete files here, for the export option.
  async filesSize() {
    return (await withDb(s => filesSize(s.db)).catch(() => 0)) ?? 0
  },

  // Whether there is an identity here to export (one that moved away has no keys left).
  available: () => useP2p.getState().ik !== null && useP2p.getState().movedAt === null,

  // Sending pauses here afterwards, until the user resumes. With `files`, also the key to write
  // the files into the `.rchat` file with (`writeFiles`).
  async exportSection(
    pass: string,
    kdf?: Kdf,
    files = false
  ): Promise<{ section: P2pSection; files: FilesKey | null }> {
    const out = await withDb(async s =>
      files
        ? exportP2pWithFiles(s.db, pass, kdf, Date.now())
        : { section: await exportP2p(s.db, pass, kdf, Date.now()), files: null }
    )
    const at = Date.now()
    const n = node
    if (n && !n.moved) await n.markExported(at)
    else
      await withDb(s =>
        s.updateSelf(cur => (cur && !cur.moved ? { ...cur, moving: { at }, exported: at } : null))
      )
    useP2p.setState({ movingAt: at })
    return out
  },

  // Streams the files after the config text, block by block.
  async writeFiles(
    fk: FilesKey,
    write: (part: Uint8Array) => Promise<void>,
    progress?: (done: number, total: number) => void
  ) {
    await withDb(s => writeFiles(s.db, fk, write, progress))
  },

  // Decrypts and reads the file's P2P data; nothing is written.
  async unlock(section: P2pSection, pass: string, part?: FilesPart | null): Promise<Unlocked> {
    const username = useP2p.getState().account
    if (!username) throw new Error('Sign in first')
    let dump: Dump
    let files: Unlocked['files'] = null
    if (part) {
      const got = await unlockP2pWithFiles(section, pass, part.head)
      dump = got.dump
      files = { blob: part.blob, key: got.files }
    } else dump = await unlockP2p(section, pass)
    const st = useP2p.getState()
    let kind: ImportKind = 'new'
    let already = false
    if (st.ik !== null || (await hasDb(dbFor(username)))) {
      const local = await withDb(s => s.self())
      kind = importKind(local, dump)
      already = alreadyImported(local, dump)
    }
    if (kind !== 'merge' && readImports(username).includes(dump.id))
      throw new TransferError(IMPORTED_HERE)
    return { dump, summary: summarize(dump), kind, already, files }
  },

  // Runs in the tab that holds the account's P2P lock: the node stops, the import writes in one
  // transaction, and the node starts again on what is stored. Another tab running P2P keeps it.
  // The files that came with it are read in afterwards, block by block (`progress` gets bytes).
  async apply(
    u: Unlocked,
    progress?: (done: number) => void
  ): Promise<{ ok: true; res: Imported } | { ok: false; error: string }> {
    const username = useP2p.getState().account
    if (!username) return { ok: false, error: 'Sign in first' }
    if (useP2p.getState().elsewhere) return { ok: false, error: ELSEWHERE_IMPORT }
    const job = async () => {
      const s = await P2pStore.open(dbFor(username))
      try {
        const res: Imported = await applyImport(s.db, u.dump, u.kind)
        rememberImport(username, u.dump.id)
        if (u.files) res.files = await importFiles(s.db, u.files.blob, u.files.key, progress)
        return res
      } finally {
        s.close()
      }
    }
    try {
      navigator.storage?.persist?.().catch(() => {})
    } catch {
      // Best effort.
    }
    const l = leader
    if (l && l.state === 'leading') {
      const mine = gen
      stopNode()
      let out: { ok: true; res: Imported } | { ok: false; error: string }
      try {
        out = { ok: true, res: await job() }
      } catch (e) {
        out = { ok: false, error: errText(e) }
      }
      if (mine === gen && leader === l)
        await boot(username, null, l, () => mine === gen && leader === l && l.state === 'leading')
      return out
    }
    if (l) return { ok: false, error: ELSEWHERE_IMPORT }
    // P2P is off in this browser: hold the lock just for the import, then start as usual.
    const locks = webLeaderDeps().locks
    let out: { ok: true; res: Imported } | { ok: false; error: string } = {
      ok: false,
      error: ELSEWHERE_IMPORT,
    }
    const run1 = async () => {
      try {
        out = { ok: true, res: await job() }
      } catch (e) {
        out = { ok: false, error: errText(e) }
      }
    }
    if (locks)
      await locks.request(dbFor(username), { ifAvailable: true }, lock =>
        lock ? run1() : Promise.resolve()
      )
    else await run1()
    if (out.ok && useP2p.getState().account === username) {
      writeOn(username, true)
      useP2p.setState({ enabled: true })
      run(username, null)
    }
    return out
  },
}
