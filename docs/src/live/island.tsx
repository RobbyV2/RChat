import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './island.css'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button, Chip } from '../../../apps/web/app/components/controls'
import { Row, Stack, Surface } from '../../../apps/web/app/components/layout'
import { fieldLook } from '../../../apps/web/app/lib/controls'
import {
  SHOWN_HEADERS,
  effectOf,
  fillPath,
  isWrite,
  parseBody,
  placeholders,
  redactSecrets,
  showJson,
  stateText,
  type LiveAccount,
} from '../../../apps/web/app/lib/live_docs'
import { WsClient } from '../../../apps/web/app/lib/ws'
import {
  anything,
  choice,
  jsonOr,
  obj,
  opt,
  parseJson,
  record,
  str,
  type Schema,
} from '../../../apps/web/app/lib/schema'
import { Connect } from './connect'
import { Name, Note, Title } from './parts'
import {
  accountApi,
  connection,
  select,
  selectedAccount,
  setStreamer,
  start,
  stateOf,
  useLive,
} from './store'

const Who = ({ a }: { a: LiveAccount }) => (
  <>
    <Name>{a.username}</Name> on <Name>{a.host}</Name>
  </>
)

// A control with its label above it.
const Field = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <Stack as="label" gap="2xs">
    <span className="font-mono text-sm text-on-surface-variant">{label}</span>
    {children}
  </Stack>
)

function RunAs() {
  const { dynamic, accounts, selected, streamer } = useLive(
    useShallow(s => ({
      dynamic: s.dynamic,
      accounts: s.accounts,
      selected: s.selected,
      streamer: s.streamer,
    }))
  )
  const account = useLive(selectedAccount)
  const state = useLive(s => (account ? stateOf(s, account) : null))
  if (!dynamic) return null
  return (
    <Surface pad="lg" gap="md" aria-label="Run as">
      <Title>Run as</Title>
      <Row gap="sm" wrap align="start" role="radiogroup" aria-label="Account">
        {accounts.map(a => (
          <Chip key={a.key} radio on={a.key === selected} onClick={() => select(a.key)}>
            <Who a={a} />
          </Chip>
        ))}
      </Row>
      {account && state && <Note>{stateText(account, state)}</Note>}
      <Row gap="sm" wrap>
        <Chip on={streamer} onClick={() => setStreamer(!streamer)}>
          Streamer mode
        </Chip>
      </Row>
    </Surface>
  )
}

type Pick = 'server' | 'channel' | 'dm' | 'me'

interface Choice {
  value: string
  label: string
  // How a sentence names it, when that differs from the label.
  phrase?: string
}

// The choices for a placeholder, read as the account: its servers (the ones it created first),
// the text channels of the picked server, its DMs (the one with itself first) or its username.
async function choicesFor(a: LiveAccount, pick: Pick, server: string): Promise<Choice[]> {
  const api = accountApi(a)
  if (pick === 'me') return [{ value: a.username, label: a.username }]
  if (pick === 'server') {
    const page = await api.myServers(null, 50)
    const own = (s: { creator?: string | null }) => (s.creator === a.username ? 0 : 1)
    return [...page.items]
      .sort((x, y) => own(x) - own(y))
      .map(s => ({ value: s.name, label: s.display_name }))
  }
  if (pick === 'channel') {
    if (!server) return []
    const detail = await api.getServer(server)
    return detail.channels
      .filter(c => c.kind === 'text')
      .map(c => ({ value: String(c.id), label: `#${c.name}` }))
  }
  const page = await api.listDms(null, 50)
  return page.items.map(d => ({
    value: String(d.id),
    label: d.is_self ? 'Your notes' : d.other.username,
    phrase: d.is_self ? 'your notes' : undefined,
  }))
}

const KIND_NAMES: Record<Pick, string> = {
  server: 'Server',
  channel: 'Channel',
  dm: 'DM',
  me: 'Account',
}

// Choices as streamer mode shows them: numbered, without names.
const shownLabel = (pick: Pick, c: Choice, i: number, streamer: boolean) =>
  streamer ? `${KIND_NAMES[pick]} ${i + 1}` : c.label

function useChoices(account: LiveAccount, pick: Pick, server: string) {
  const [choices, setChoices] = useState<Choice[] | null>(null)
  useEffect(() => {
    let live = true
    setChoices(null)
    choicesFor(account, pick, server).then(
      list => {
        if (live) setChoices(list)
      },
      () => {
        if (live) setChoices([])
      }
    )
    return () => {
      live = false
    }
  }, [account, pick, server])
  return choices
}

function Select({
  label,
  pick,
  choices,
  value,
  onChange,
}: {
  label: string
  pick: Pick
  choices: Choice[] | null
  value: string
  onChange: (c: Choice) => void
}) {
  const streamer = useLive(s => s.streamer)
  useEffect(() => {
    if (choices?.length && !choices.some(c => c.value === value)) onChange(choices[0])
  }, [choices, value, onChange])
  return (
    <Field label={label}>
      {choices === null ? (
        <Note>Loading</Note>
      ) : choices.length === 0 ? (
        <Note>Nothing to pick</Note>
      ) : (
        <select
          className={fieldLook}
          value={value}
          onChange={e => {
            const c = choices.find(x => x.value === e.target.value)
            if (c) onChange(c)
          }}
        >
          {choices.map((c, i) => (
            <option key={c.value} value={c.value}>
              {shownLabel(pick, c, i, streamer)}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

// A placeholder filled from the account's own servers, channels or DMs.
function Picker({
  name,
  pick,
  account,
  value,
  onChange,
}: {
  name: string
  pick: Pick
  account: LiveAccount
  value: string
  onChange: (c: Choice) => void
}) {
  const [server, setServer] = useState('')
  const servers = useChoices(account, 'server', '')
  const choices = useChoices(account, pick, pick === 'channel' ? server : '')
  const pickServer = useCallback((c: Choice) => setServer(c.value), [])
  return (
    <>
      {pick === 'channel' && (
        <Select
          label="Server"
          pick="server"
          choices={servers}
          value={server}
          onChange={pickServer}
        />
      )}
      {(pick !== 'channel' || server) && (
        <Select
          label={`{${name}}`}
          pick={pick}
          choices={choices}
          value={value}
          onChange={onChange}
        />
      )}
    </>
  )
}

function JsonView({ value }: { value: unknown }) {
  const streamer = useLive(s => s.streamer)
  const parts = useMemo(() => showJson(redactSecrets(value), streamer), [value, streamer])
  return (
    <Surface pad="md" tone="lowest" radius="md">
      <pre className="overflow-auto font-mono text-xs">
        {parts.map((p, i) =>
          p.personal ? (
            <span key={i} className="streamer">
              {p.text}
            </span>
          ) : (
            p.text
          )
        )}
      </pre>
    </Surface>
  )
}

interface Answer {
  status: number
  statusText: string
  headers: [string, string][]
  body: unknown
}

function AnswerView({ answer }: { answer: Answer }) {
  return (
    <Stack gap="sm">
      <Note>
        <strong>{answer.status}</strong> {answer.statusText}
      </Note>
      {answer.headers.length > 0 && (
        <Stack as="ul" gap="2xs">
          {answer.headers.map(([k, v]) => (
            <li key={k} className="text-sm text-on-surface-variant">
              <code>{k}</code>: {v}
            </li>
          ))}
        </Stack>
      )}
      <JsonView value={answer.body} />
    </Stack>
  )
}

// An effect text with its `{name}` placeholders shown as what was picked for them.
function Effect({ text, labels }: { text: string; labels: Record<string, string> }) {
  return (
    <>
      {text.split(/(\{[A-Za-z0-9_]+\})/).map((part, i) => {
        const name = /^\{([A-Za-z0-9_]+)\}$/.exec(part)?.[1]
        return name && labels[name] ? <Name key={i}>{labels[name]}</Name> : part
      })}
    </>
  )
}

interface TryProps {
  method: string
  path: string
  body?: string
  effect?: string
  picks?: Record<string, Pick>
}

const TRY_PROPS: Schema<TryProps> = obj({
  method: str(),
  path: str(),
  body: opt(str()),
  effect: opt(str()),
  picks: opt(record(choice('server', 'channel', 'dm', 'me'))),
})

function Try({ method, path: template, body: initial = '', effect, picks = {} }: TryProps) {
  const account = useLive(selectedAccount)
  const state = useLive(s => (account ? stateOf(s, account) : null))
  const dynamic = useLive(s => s.dynamic)
  const [path, setPath] = useState(template)
  const [body, setBody] = useState(initial)
  const [values, setValues] = useState<Record<string, string>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})
  const choose = useCallback(
    (name: string) => (c: Choice) => {
      setValues(old => (old[name] === c.value ? old : { ...old, [name]: c.value }))
      setLabels(old => ({ ...old, [name]: c.phrase ?? c.label }))
    },
    []
  )
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)
  if (!dynamic || !account) return null
  const names = placeholders(path)
  const filled = fillPath(path, values)
  const parsed = parseBody(body)
  const ready = state === 'ready' && filled !== null && parsed.ok && !busy
  const run = async () => {
    if (!filled || !parsed.ok) return
    setAsking(false)
    setBusy(true)
    setError(null)
    try {
      const res = await accountApi(account).send(method, filled, parsed.value, {
        timeoutMs: 15000,
      })
      const text = await res.text()
      const read = text ? parseJson(text, anything) : null
      const shown: unknown = read === null ? null : read.ok ? read.value : text
      setAnswer({
        status: res.status,
        statusText: res.statusText,
        headers: SHOWN_HEADERS.flatMap(h => {
          const v = res.headers.get(h)
          return v === null ? [] : [[h, v] as [string, string]]
        }),
        body: shown,
      })
    } catch {
      setError(`Could not reach ${account.host}.`)
    } finally {
      setBusy(false)
    }
  }
  const click = () => (isWrite(method) ? setAsking(true) : void run())
  const shownPath = filled !== null && names.length ? filled : path
  return (
    <Surface pad="lg" gap="md" aria-label="Request">
      <Field label={method}>
        <input
          className={`${fieldLook} font-mono ${filled !== null && names.length ? 'streamer' : ''}`}
          aria-label="Path"
          value={shownPath}
          onChange={e => {
            setPath(e.target.value)
            setValues({})
          }}
        />
      </Field>
      {names.map(name =>
        picks[name] ? (
          <Picker
            key={`${name}:${account.key}`}
            name={name}
            pick={picks[name]}
            account={account}
            value={values[name] ?? ''}
            onChange={choose(name)}
          />
        ) : (
          <Field key={name} label={`{${name}}`}>
            <input
              className={`${fieldLook} font-mono`}
              value={values[name] ?? ''}
              onChange={e => setValues(old => ({ ...old, [name]: e.target.value }))}
            />
          </Field>
        )
      )}
      {(isWrite(method) || initial) && (
        <Field label="Body">
          <textarea
            className={`${fieldLook} font-mono`}
            rows={Math.min(8, body.split('\n').length + 1)}
            value={body}
            onChange={e => setBody(e.target.value)}
          />
        </Field>
      )}
      {!parsed.ok && <Note error>{parsed.error}</Note>}
      {asking ? (
        <Surface pad="md" gap="md" tone="lowest" radius="lg" aria-label="Confirm the request">
          <Note>
            <Effect text={effectOf(effect, method, template)} labels={labels} /> as{' '}
            <Who a={account} />.
          </Note>
          <Row gap="sm">
            <Button variant="filled" size="md" onClick={() => void run()}>
              Send
            </Button>
            <Button size="md" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </Row>
        </Surface>
      ) : (
        <Row gap="md">
          <Button variant="filled" size="md" disabled={!ready} busy={busy} onClick={click}>
            Run as <Who a={account} />
          </Button>
          {state !== 'ready' && state !== null && <Note>{stateText(account, state)}</Note>}
        </Row>
      )}
      {error && <Note error>{error}</Note>}
      {answer && <AnswerView answer={answer} />}
    </Surface>
  )
}

interface Seen {
  n: number
  type: string
  payload: unknown
}

const EVENTS_KEPT = 100

// One event: its type, and its payload while open. Streamer mode keeps new ones closed.
function EventItem({ event }: { event: Seen }) {
  const [open, setOpen] = useState(() => !useLive.getState().streamer)
  return (
    <Surface pad="sm" gap="sm" tone="low" radius="lg">
      <Row gap="sm">
        <Button
          icon={open ? ChevronDown : ChevronRight}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <code>{event.type}</code>
        </Button>
      </Row>
      {open && <JsonView value={event.payload} />}
    </Surface>
  )
}

function Events() {
  const account = useLive(selectedAccount)
  const state = useLive(s => (account ? stateOf(s, account) : null))
  const dynamic = useLive(s => s.dynamic)
  const [events, setEvents] = useState<Seen[]>([])
  const [open, setOpen] = useState(false)
  const [watching, setWatching] = useState(false)
  const socket = useRef<WsClient | null>(null)
  const count = useRef(0)
  const stop = () => {
    socket.current?.stop()
    socket.current = null
    setOpen(false)
    setWatching(false)
  }
  useEffect(() => () => socket.current?.stop(), [])
  useEffect(stop, [account?.key])
  if (!dynamic || !account) return null
  const watch = () => {
    const ws = new WsClient(connection(account.origin).socketEndpoints)
    ws.onStatus = status => setOpen(status === 'green')
    ws.onEvent = ev => {
      count.current += 1
      const seen = { n: count.current, type: ev.type, payload: ev }
      setEvents(old => [seen, ...old].slice(0, EVENTS_KEPT))
    }
    socket.current = ws
    setWatching(true)
    ws.start(account.token)
  }
  const status =
    state !== 'ready' && state !== null
      ? stateText(account, state)
      : open
        ? 'Connected. New events show first.'
        : watching
          ? 'Connecting'
          : `${events.length} events`
  return (
    <Surface pad="lg" gap="md" aria-label="Events">
      <Row gap="md">
        {watching ? (
          <Button variant="filled" size="md" onClick={stop}>
            Stop watching
          </Button>
        ) : (
          <Button variant="filled" size="md" disabled={state !== 'ready'} onClick={watch}>
            Watch events as <Who a={account} />
          </Button>
        )}
        <Note>{status}</Note>
      </Row>
      {events.length > 0 && (
        <Stack gap="sm">
          {events.map(e => (
            <EventItem key={e.n} event={e} />
          ))}
        </Stack>
      )}
    </Surface>
  )
}

// Mounts the bar, the snippets, the event views and the app box of this page, then reads where it
// runs and the accounts.
export function mount() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-live]:not([data-mounted])')) {
    el.dataset.mounted = ''
    const kind = el.dataset.live
    const root = createRoot(el)
    if (kind === 'run-as') root.render(<RunAs />)
    if (kind === 'events') root.render(<Events />)
    if (kind === 'connect') root.render(<Connect />)
    if (kind === 'try') {
      const props = jsonOr(el.dataset.props ?? null, TRY_PROPS, null)
      if (props) root.render(<Try {...props} />)
    }
  }
  void start()
}
