import { create } from 'zustand'
import { ApiError, readStart } from './api'
import { apiBaseOf, apiDescription, sendWritten } from './asks'
import { Ended } from './slices/ctx'
import { readLocal, writeLocal } from './instances'
import {
  EMPTY_HISTORY,
  historyKey,
  historyValue,
  parseHistory,
  parseOpenApi,
  prettyBody,
  pushHistory,
  requestPath,
  type ApiHistory,
  type BuiltRequest,
  type HistoryEntry,
  type Operation,
} from './openapi'
import { client } from './client/client'
import type { AccountSession } from './client/session'
import { accountBoundStore } from './client/react'

// The operations of this instance's OpenAPI document (loaded once per session and account) and
// the console's request history per account.
interface ApiDocState {
  key: string | null
  ops: Operation[] | null
  loading: boolean
  error: string | null
  owner: string | null
  history: ApiHistory
}

export interface ApiResponse {
  status: number
  statusText: string
  headers: [string, string][]
  ms: number
  text: string
  json: boolean
  cut: boolean
  size: number
}

// Bytes of a response read for display; the rest is not downloaded.
export const RESPONSE_MAX = 2 * 1024 * 1024

const emptyHistory = (): ApiHistory => ({ ...EMPTY_HISTORY, items: [] })

export function createApiDoc(acct: AccountSession) {
  const { conn: home } = acct
  const { sessionMark } = acct.lifetime
  let generation = 0
  let disposed = false
  const useApiDoc = create<ApiDocState>(() => ({
    key: null,
    ops: null,
    loading: false,
    error: null,
    owner: null,
    history: emptyHistory(),
  }))

  // Per instance and account: what one account loaded is not shown to the next.
  const docKey = () => `${apiBaseOf(acct)}\n${home.scoped(useApiDoc.getState().owner ?? 'guest')}`

  const loadApiDoc = async (force = false) => {
    if (disposed) return
    const at = sessionMark()
    const key = docKey()
    const st = useApiDoc.getState()
    if (!force && st.key === key && (st.ops || st.loading)) return
    const request = ++generation
    useApiDoc.setState({ key, loading: true, error: null })
    try {
      const doc = await apiDescription(acct)
      if (request !== generation || at !== sessionMark() || useApiDoc.getState().key !== key) return
      useApiDoc.setState({ ops: parseOpenApi(doc), loading: false })
    } catch (e) {
      if (request !== generation || at !== sessionMark() || useApiDoc.getState().key !== key) return
      const status = e instanceof ApiError ? e.status : 0
      useApiDoc.setState({
        ops: null,
        loading: false,
        error:
          status === 401 || status === 403
            ? 'Sign in to see the API.'
            : "Couldn't load the API description.",
      })
    }
  }

  // Reads the account's history; older entries that kept filled-in paths are rewritten without them.
  const loadApiHistory = (owner: string | null) => {
    const key = home.scoped(historyKey(owner))
    let history: ApiHistory
    try {
      const raw = readLocal(key)
      const parsed = parseHistory(raw)
      history = parsed === EMPTY_HISTORY ? emptyHistory() : parsed
      if (raw !== null && historyValue(history) !== raw)
        writeLocal(key, history.items.length ? historyValue(history) : null)
    } catch {
      history = emptyHistory()
    }
    const changed = useApiDoc.getState().owner !== owner
    useApiDoc.setState(
      changed
        ? { owner, history, key: null, ops: null, loading: false, error: null }
        : { owner, history }
    )
  }

  // `at`: the session that sent it; a request that answers after it ended is not kept.
  const noteRequest = (entry: HistoryEntry, at: object) => {
    if (disposed || at !== sessionMark()) return
    const { owner, history } = useApiDoc.getState()
    const next = pushHistory(history, entry)
    useApiDoc.setState({ history: next })
    writeLocal(home.scoped(historyKey(owner)), historyValue(next))
  }

  const clearApiHistory = () => {
    const { owner } = useApiDoc.getState()
    useApiDoc.setState({ history: emptyHistory() })
    writeLocal(home.scoped(historyKey(owner)), null)
  }

  // Sends a built request with the signed-in user's own token (or guest grants).
  const sendRequest = async (r: BuiltRequest): Promise<ApiResponse> => {
    if (disposed) throw new Ended()
    const mark = sessionMark()
    const path = requestPath(r)
    if (path === null) throw new ApiError('Only API paths can be called', 0)
    const started = acct.time.elapsed()
    const res = await acct.lifetime.live(
      sendWritten(acct, { method: r.method, path, body: r.body, headers: r.headers })
    )
    if (disposed || mark !== sessionMark()) throw new Ended()
    const type = res.headers.get('content-type')
    let raw = ''
    let cut = false
    let size = 0
    if (res.body) {
      const read = await acct.lifetime.live(readStart(res.body, RESPONSE_MAX))
      if (disposed || mark !== sessionMark()) throw new Ended()
      raw = new TextDecoder().decode(read.bytes)
      cut = read.cut
      size = read.bytes.length
    }
    const shown = prettyBody(raw, type)
    return {
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers.entries()],
      ms: Math.round(acct.time.elapsed() - started),
      text: shown.text,
      json: shown.json && !cut,
      cut: cut || shown.cut,
      size,
    }
  }

  const reset = () => {
    generation++
    useApiDoc.setState(useApiDoc.getInitialState())
  }

  return {
    useApiDoc,
    loadApiDoc,
    loadApiHistory,
    noteRequest,
    clearApiHistory,
    sendRequest,
    reset,
    dispose() {
      disposed = true
      reset()
    },
  }
}
export const useApiDoc = accountBoundStore<ApiDocState>(acct => acct.apiDoc.useApiDoc)
export const loadApiDoc = (force?: boolean) => client.shown().apiDoc.loadApiDoc(force)
export const loadApiHistory = (owner: string | null) => client.shown().apiDoc.loadApiHistory(owner)
export const noteRequest = (entry: HistoryEntry, at: object) =>
  client.shown().apiDoc.noteRequest(entry, at)
export const clearApiHistory = () => client.shown().apiDoc.clearApiHistory()
export const sendRequest = (request: BuiltRequest) => client.shown().apiDoc.sendRequest(request)
