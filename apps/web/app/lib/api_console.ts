import { create } from 'zustand'
import { ApiError, readStart } from './api'
import { api, home, writeLocal } from './instances'
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

export const useApiDoc = create<ApiDocState>(() => ({
  key: null,
  ops: null,
  loading: false,
  error: null,
  owner: null,
  history: EMPTY_HISTORY,
}))

// Per instance and account: what one account loaded is not shown to the next.
const docKey = () => `${api.base}\n${home.scoped(useApiDoc.getState().owner ?? 'guest')}`

export const loadApiDoc = async (force = false) => {
  const key = docKey()
  const st = useApiDoc.getState()
  if (!force && st.key === key && (st.ops || st.loading)) return
  useApiDoc.setState({ key, loading: true, error: null })
  try {
    const doc = await api.req<unknown>('GET', '/openapi.json')
    if (useApiDoc.getState().key !== key) return
    useApiDoc.setState({ ops: parseOpenApi(doc), loading: false })
  } catch (e) {
    if (useApiDoc.getState().key !== key) return
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
export const loadApiHistory = (owner: string | null) => {
  const key = home.scoped(historyKey(owner))
  let history: ApiHistory
  try {
    const raw = localStorage.getItem(key)
    history = parseHistory(raw)
    if (raw !== null && historyValue(history) !== raw)
      writeLocal(key, history.items.length ? historyValue(history) : null)
  } catch {
    history = EMPTY_HISTORY
  }
  const changed = useApiDoc.getState().owner !== owner
  useApiDoc.setState(
    changed
      ? { owner, history, key: null, ops: null, loading: false, error: null }
      : { owner, history }
  )
}

export const noteRequest = (entry: HistoryEntry) => {
  const { owner, history } = useApiDoc.getState()
  const next = pushHistory(history, entry)
  useApiDoc.setState({ history: next })
  writeLocal(home.scoped(historyKey(owner)), historyValue(next))
}

export const clearApiHistory = () => {
  const { owner } = useApiDoc.getState()
  useApiDoc.setState({ history: EMPTY_HISTORY })
  writeLocal(home.scoped(historyKey(owner)), null)
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

// Sends a built request with the signed-in user's own token (or guest grants).
export const sendRequest = async (r: BuiltRequest): Promise<ApiResponse> => {
  const path = requestPath(r)
  if (path === null) throw new ApiError('Only API paths can be called', 0)
  const started = performance.now()
  const res = await api.send(r.method, path, r.body, r.headers)
  const type = res.headers.get('content-type')
  let raw = ''
  let cut = false
  let size = 0
  if (res.body) {
    const read = await readStart(res.body, RESPONSE_MAX)
    raw = new TextDecoder().decode(read.bytes)
    cut = read.cut
    size = read.bytes.length
  }
  const shown = prettyBody(raw, type)
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    ms: Math.round(performance.now() - started),
    text: shown.text,
    json: shown.json && !cut,
    cut: cut || shown.cut,
    size,
  }
}
