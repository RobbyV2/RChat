import type { RecordTable } from '../platform/records'
import { ECHO_MIN, hiddenNames, loggedArgs, type LogStep } from './policy'
import { scrubEntry, stripSpans, stripValues } from './redact'
import { PRUNE_EVERY, pruneOpts } from './retention'
import type {
  LogActor,
  LogEntry,
  LogOutcome,
  LogPrefs,
  LogResult,
  LogSpan,
  LogTarget,
  LogUndo,
  LogVia,
} from './types'
import { time } from '../platform/time'

export const WRITE_MS = 250
const LIVE_UNDOS = 200

export interface LoggedAction {
  id: string
  title: string
  // Logged as title and outcome only.
  secret?: boolean
  // Never logged.
  egg?: boolean
  steps?: LogStep[]
  // A server's command: its text arguments are hidden whatever it declares.
  serverCommand?: boolean
}

export interface ActionRun {
  actor: LogActor
  via: LogVia
  action: LoggedAction
  args?: Record<string, string>
  target?: LogTarget
  // What the run answered; none for a run that answered nothing or was cancelled.
  result?: LogResult
  cancelled?: boolean
  // Where the server put argument values in the result's text.
  spans?: LogSpan[]
  ms?: number
}

export interface ApiCall {
  actor: LogActor
  method: string
  // The path as typed, with its query.
  path: string
  status: number
  ms?: number
}

export interface NoticeSeen {
  actor: LogActor
  title: string
  text: string
  spans?: LogSpan[]
  target?: LogTarget
}

export interface RecorderDeps {
  table: RecordTable<LogEntry>
  prefs: () => LogPrefs
  now?: () => number
  id?: () => string
  later?: (run: () => void, ms: number) => void
}

const randomId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

const OUTCOME: Record<LogResult['kind'], LogOutcome> = { ok: 'ok', info: 'info', error: 'error' }

const argOf = (span: LogSpan) => (span.arg.startsWith('args.') ? span.arg.slice(5) : span.arg)

// The text of a reply without the arguments the log hides: the marked spans of every argument
// that is not kept, then their exact values. Spans mark `text`, so a `detail`, which the log
// keeps instead, loses the exact values only.
const withoutEchoes = (run: ActionRun, { text, name, detail }: LogResult) => {
  const { action, args = {}, spans = [] } = run
  const steps = action.steps ?? []
  const declared = new Set(steps.map(s => s.name))
  const hidden = new Set([
    ...hiddenNames(steps, args, false, action.serverCommand),
    ...Object.keys(args).filter(name => !declared.has(name)),
  ])
  const kept = new Set(steps.map(s => s.name).filter(name => !hidden.has(name)))
  const marked = spans.filter(sp => !kept.has(argOf(sp))).map(sp => ({ ...sp, arg: 'x' }))
  const values = [...hidden].map(n => args[n]).filter(v => Array.from(v).length >= ECHO_MIN)
  if (detail !== undefined) return stripValues(detail, values)
  const shown = stripSpans(text, marked, new Set(['x']))
  return stripValues(name ? `${shown} ${name}` : shown, values)
}

const apiTitle = (method: string, path: string) => {
  const [before] = path.split('#')
  const at = before.indexOf('?')
  const keys = (at === -1 ? '' : before.slice(at + 1))
    .split('&')
    .filter(pair => pair.includes('='))
    .map(pair => pair.slice(0, pair.indexOf('=')))
    .filter(Boolean)
  const where = at === -1 ? before : before.slice(0, at)
  return `${method.toUpperCase()} ${where}${keys.length ? `?${keys.join('&')}` : ''}`
}

// Writes the log of one account: entries are scrubbed, batched into one write per 250 ms, and
// the table is pruned at start and every 50 writes. Nothing here throws into a command.
export const recorder = ({
  table,
  prefs,
  now = () => time().now(),
  id = randomId,
  later = (run, ms) => void time().after(ms, run),
}: RecorderDeps) => {
  let queue: LogEntry[] = []
  let waiting = false
  let written = 0
  let chain: Promise<void> = Promise.resolve()
  const undos = new Map<string, LogEntry>()

  const pruneNow = async () => {
    try {
      await table.prune(pruneOpts(prefs(), now()))
    } catch {
      // The next one may work.
    }
  }

  const write = async () => {
    const batch = queue
    queue = []
    if (!batch.length) return
    try {
      await table.put(batch)
    } catch {
      return
    }
    const before = Math.floor(written / PRUNE_EVERY)
    written += batch.length
    if (Math.floor(written / PRUNE_EVERY) > before) await pruneNow()
  }

  const flush = () => {
    waiting = false
    chain = chain.then(write)
    return chain
  }

  const add = (entry: LogEntry) => {
    const at = queue.findIndex(e => e.id === entry.id)
    if (at === -1) queue.push(entry)
    else queue[at] = entry
    if (waiting) return
    waiting = true
    later(() => void flush(), WRITE_MS)
  }

  const base = (actor: LogActor, via: LogVia, action: string, title: string) => ({
    v: 1 as const,
    id: id(),
    at: now(),
    actor,
    via,
    action,
    title,
  })

  const keep = (entry: LogEntry) => {
    const clean = scrubEntry(entry)
    if (clean.undo === 'available') {
      if (undos.size >= LIVE_UNDOS) undos.delete(undos.keys().next().value ?? '')
      undos.set(clean.id, clean)
    }
    add(clean)
    return clean.id
  }

  return {
    // Prunes; call once when the account's session starts.
    start: () => {
      chain = chain.then(pruneNow)
      return chain
    },
    flush,
    action: (run: ActionRun): string | null => {
      const { actor, via, action, args = {}, target, result, cancelled, ms } = run
      if (action.egg || !prefs().on) return null
      const outcome: LogOutcome = cancelled ? 'cancelled' : result ? OUTCOME[result.kind] : 'ok'
      const head = base(actor, via, action.id, action.title)
      if (action.secret) return keep({ ...head, outcome })
      const logged = loggedArgs(action.steps ?? [], args, false, action.serverCommand)
      return keep({
        ...head,
        ...(target ? { target } : {}),
        ...(logged.length ? { args: logged } : {}),
        outcome,
        ...(result && !cancelled ? { text: withoutEchoes(run, result) } : {}),
        ...(ms === undefined ? {} : { ms }),
        ...(result?.undo && !cancelled ? { undo: 'available' as const } : {}),
      })
    },
    api: ({ actor, method, path, status, ms }: ApiCall): string | null =>
      prefs().on
        ? keep({
            ...base(actor, 'api', 'api', apiTitle(method, path)),
            outcome: status >= 200 && status < 400 ? 'ok' : 'error',
            text: String(status),
            ...(ms === undefined ? {} : { ms }),
          })
        : null,
    // A reply only this account saw. Which arguments it echoes is not known here, so every
    // marked span is hidden.
    notice: ({ actor, title, text, spans = [], target }: NoticeSeen): string | null =>
      prefs().on
        ? keep({
            ...base(actor, 'notice', 'notice', title),
            ...(target ? { target } : {}),
            outcome: 'info',
            text: stripSpans(
              text,
              spans.map(sp => ({ ...sp, arg: 'x' })),
              new Set(['x'])
            ),
          })
        : null,
    // What became of an entry's undo.
    undo: (entry: string, state: Exclude<LogUndo, 'available'>) => {
      const known = undos.get(entry)
      if (!known) return
      undos.delete(entry)
      add({ ...known, undo: state })
    },
    // Entries the user deleted: their undo no longer writes them back.
    forget: (entries: string[]) => {
      for (const entry of entries) undos.delete(entry)
      queue = queue.filter(e => !entries.includes(e.id))
    },
  }
}

export type Recorder = ReturnType<typeof recorder>
