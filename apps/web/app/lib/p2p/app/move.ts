import { legacyScope } from './store'
import { P2pStore } from '../db'
import { webLeaderDeps } from '../leader'
import {
  alreadyImported,
  applyImport,
  Cancelled,
  defaultKdf,
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
  type KdfWatch,
  type P2pSection,
  type Summary,
} from '../transfer'
import * as storePart from './store'
import * as accountPart from './account'
import type { IdentityScope, P2pParts } from './scope'

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
export function createMovePart(parts: Pick<P2pParts, 'store' | 'account'>, scope: IdentityScope) {
  const state = parts.store
  const { useP2p, writeOn, readImports, rememberImport } = state

  // ----- Device move -----

  const ELSEWHERE_IMPORT = 'P2P is open in another tab. Use it here first.'

  const errText = (e: unknown) =>
    e instanceof TransferError || e instanceof Error ? e.message : String(e)

  const operationFor = (username: string) => {
    const name = parts.account.dbFor(username)
    const signal = scope.resetSignal()
    const current = () =>
      !signal.aborted &&
      scope.current(username) &&
      useP2p.getState().account === username &&
      parts.account.dbFor(username) === name
    const check = () => {
      if (!current()) throw new Cancelled()
    }
    return { name, current, check, signal }
  }

  const signedIn = () => {
    const username = useP2p.getState().account
    if (!username || !scope.current(username)) throw new Error('Sign in first')
    return username
  }

  // The database of this account, for a moment: the running node's, or opened just for this.
  const withDb = async <T>(
    fn: (s: P2pStore) => Promise<T>,
    op = operationFor(signedIn())
  ): Promise<T> => {
    op.check()
    const live = state.store ?? state.reader?.store
    const borrowed = live && !live.closed
    const s = borrowed ? live : await P2pStore.open(op.name)
    try {
      op.check()
      const result = await fn(s)
      op.check()
      return result
    } finally {
      if (!borrowed) s.close()
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

  const p2pTransfer = {
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
      files = false,
      watch?: KdfWatch
    ): Promise<{ section: P2pSection; files: FilesKey | null }> {
      const username = signedIn()
      const op = operationFor(username)
      const k = kdf ?? defaultKdf(state.identityLimits(username).transfer)
      const out = await withDb(async s =>
        files
          ? exportP2pWithFiles(s.db, pass, k, Date.now(), watch)
          : { section: await exportP2p(s.db, pass, k, Date.now(), watch), files: null }
      )
      op.check()
      if (watch?.signal?.aborted) throw new Cancelled()
      const at = Date.now()
      const n = state.node
      if (n && !n.moved) await n.markExported(at)
      else
        await withDb(s =>
          s.updateSelf(cur => (cur && !cur.moved ? { ...cur, moving: { at }, exported: at } : null))
        )
      op.check()
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
    async unlock(
      section: P2pSection,
      pass: string,
      part?: FilesPart | null,
      watch?: KdfWatch
    ): Promise<Unlocked> {
      const username = signedIn()
      const op = operationFor(username)
      let dump: Dump
      let files: Unlocked['files'] = null
      const lim = state.identityLimits(username)
      if (part) {
        const got = await unlockP2pWithFiles(section, pass, part.head, lim, watch)
        dump = got.dump
        files = { blob: part.blob, key: got.files }
      } else dump = await unlockP2p(section, pass, lim, watch)
      op.check()
      const st = useP2p.getState()
      let kind: ImportKind = 'new'
      let already = false
      if (st.ik !== null || (await hasDb(op.name))) {
        const local = await withDb(s => s.self(), op)
        kind = importKind(local, dump)
        already = alreadyImported(local, dump)
      }
      op.check()
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
      if (!username || !scope.current(username)) return { ok: false, error: 'Sign in first' }
      if (useP2p.getState().elsewhere) return { ok: false, error: ELSEWHERE_IMPORT }
      const op = operationFor(username)
      const job = async () => {
        op.check()
        const s = await P2pStore.open(op.name)
        const close = () => s.close()
        try {
          op.check()
          op.signal.addEventListener('abort', close)
          const lim = state.identityLimits(username)
          const res: Imported = await applyImport(s.db, u.dump, u.kind, {
            lim,
            signal: op.signal,
            check: op.check,
          })
          op.check()
          rememberImport(username, u.dump.id)
          if (u.files)
            res.files = await importFiles(s.db, u.files.blob, u.files.key, progress, lim.transfer)
          op.check()
          return res
        } finally {
          op.signal.removeEventListener('abort', close)
          s.close()
        }
      }
      try {
        navigator.storage?.persist?.().catch(() => {})
      } catch {
        // Best effort.
      }
      const l = state.leader
      if (l && l.state === 'leading') {
        parts.account.stopNode()
        let out: { ok: true; res: Imported } | { ok: false; error: string }
        try {
          out = { ok: true, res: await job() }
        } catch (e) {
          out = { ok: false, error: errText(e) }
        }
        if (op.current() && state.leader === l)
          await parts.account.boot(
            username,
            null,
            l,
            () => op.current() && state.leader === l && l.state === 'leading'
          )
        return out
      }
      if (l) return { ok: false, error: ELSEWHERE_IMPORT }
      // P2P is off in this browser: hold the lock just for the import, then start as usual.
      const locks = (scope.options.leaderDeps ?? webLeaderDeps)().locks
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
        await locks.request(op.name, { ifAvailable: true }, lock =>
          lock ? run1() : Promise.resolve()
        )
      else await run1()
      if (out.ok && op.current()) {
        writeOn(username, true)
        useP2p.setState({ enabled: true })
        parts.account.run(username, null)
      }
      return out
    },
  }
  return { ELSEWHERE_IMPORT, p2pTransfer }
}

export const legacyMove = createMovePart(
  {
    store: storePart,
    account: accountPart,
  },
  legacyScope
)
export const { ELSEWHERE_IMPORT, p2pTransfer } = legacyMove
