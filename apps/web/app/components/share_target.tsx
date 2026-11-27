'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AccountProvider, useLiveSessions, useStore } from '../lib/client/react'
import { P2pProvider, useP2p } from '../lib/client/p2p_react'
import { client } from '../lib/client/client'
import {
  allowsAccountOrigin,
  hostedPolicyRevision,
  watchHostedPolicy,
} from '../lib/client/hosted_policy'
import { createSwitcherSource, liveSwitcherRows } from '../lib/client/switcher_rows'
import { shareChoices as choices, prepareShareOwner } from '../lib/client/share_owners'
import { awaitingInstance } from '../lib/instances'
import { keptSession } from '../lib/start'
import { usePathname } from 'next/navigation'
import { invoke, mobileOs } from '../lib/platform/desktop'
import { watchIncomingShares } from '../lib/platform/incoming_share'
import {
  attachShare,
  shareRooms,
  type SharedContent,
  type ShareOwner,
} from '../lib/client/share_target'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { Dialog, fieldCls } from './ui'
import { time } from '../lib/platform/time'

function Destinations({
  owner,
  streamer,
  content,
  close,
  valid,
}: {
  owner: ShareOwner
  streamer: boolean
  content: SharedContent
  close: () => void
  valid: () => boolean
}) {
  const state = useStore(s => s)
  useP2p(s => s)
  owner.account.viewing.useViewing(s => s.revision)
  const [fileIndex, setFileIndex] = useState(0)
  const [room, setRoom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(false),
    request = useRef(0)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      request.current++
    }
  }, [])
  const files =
    owner.identity || content.files.length < 2 ? content.files : [content.files[fileIndex]]
  const rooms = shareRooms(owner, files, streamer)
  const dest = rooms.find(r => r.key === room)
  const joined = state.me?.servers ?? []
  const [loading, setLoading] = useState('')
  async function load(name: string) {
    if (!allowsAccountOrigin(owner.account.conn.origin)) return
    setLoading(name)
    try {
      await owner.account.store.getState().discoverChannels(name, true)
    } catch {
      if (live.current) setError('Could not load those channels.')
    } finally {
      if (live.current) setLoading('')
    }
  }
  async function submit() {
    if (!dest || dest.reason || busy) return
    setBusy(true)
    setError('')
    const mark = ++request.current
    const current = () => valid() && live.current && request.current === mark
    try {
      if (await attachShare(owner, dest.key, { text: content.text, files }, current)) {
        if (current()) close()
      } else if (current()) setError('This destination is no longer available.')
    } catch {
      if (current()) setError('Could not open this destination.')
    } finally {
      if (current()) setBusy(false)
    }
  }
  return (
    <>
      {!owner.identity && content.files.length > 1 && (
        <Stack as="label" gap="2xs">
          Choose one attachment for this draft
          <select
            className={fieldCls}
            aria-label="Choose one attachment for this draft"
            value={fileIndex}
            onChange={e => {
              request.current++
              setBusy(false)
              setFileIndex(Number(e.target.value))
            }}
          >
            {content.files.map((f, i) => (
              <option key={i} value={i}>
                {f.name}
              </option>
            ))}
          </select>
        </Stack>
      )}
      <Stack as="label" gap="2xs">
        Destination
        <select
          className={fieldCls}
          aria-label="Destination"
          value={dest?.key ?? ''}
          disabled={busy}
          onChange={e => setRoom(e.target.value)}
        >
          <option value="">Choose a conversation or channel</option>
          {rooms.map(r => (
            <option key={r.key} value={r.key} disabled={!!r.reason}>
              {r.label}
              {r.reason ? ' — ' + r.reason : ''}
            </option>
          ))}
        </select>
      </Stack>
      {!owner.identity &&
        joined
          .filter(s => !state.servers[s.name])
          .map((s, i) => (
            <Button key={s.name} disabled={!!loading || busy} onClick={() => void load(s.name)}>
              Load channels in {state.streamer || streamer ? 'Server ' + (i + 1) : s.display_name}
            </Button>
          ))}
      {!owner.identity && state.serversMore && (
        <Button
          onClick={() =>
            allowsAccountOrigin(owner.account.conn.origin) && void state.loadMoreServers()
          }
        >
          More servers
        </Button>
      )}
      {!owner.identity && state.dmsMore && (
        <Button
          onClick={() => allowsAccountOrigin(owner.account.conn.origin) && void state.loadMoreDms()}
        >
          More direct messages
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <Row gap="sm" justify="end">
        <Button size="md" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="filled"
          size="md"
          disabled={!dest || !!dest.reason || busy}
          onClick={() => void submit()}
        >
          Open draft
        </Button>
      </Row>
    </>
  )
}
function Picker({
  content,
  close,
  valid,
}: {
  content: SharedContent
  close: () => void
  valid: () => boolean
}) {
  const [source] = useState(createSwitcherSource)
  const model = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  useLiveSessions()
  useSyncExternalStore(watchHostedPolicy, hostedPolicyRevision, hostedPolicyRevision)
  const owners = choices(model.groups)
  const shown = client.shown()
  const [key, setKey] = useState(
    () =>
      owners.find(
        o =>
          o.ready?.account === shown &&
          (shown.identities.coversView()
            ? o.ready.identity === shown.identities.viewed()
            : !o.local)
      )?.key ?? ''
  )
  const selected = owners.find(o => o.key === key)
  const [prepared, setPrepared] = useState(() => selected?.ready ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const selection = useRef(0)
  const mark = selection.current
  const streamer = useStore(s => s.streamer)
  const ready =
    prepared &&
    selected?.ready?.account === prepared.account &&
    selected.ready.identity === prepared.identity
      ? prepared
      : null
  async function select(key: string) {
    const id = ++selection.current
    const current = () => valid() && selection.current === id
    setKey(key)
    setError('')
    const available = owners.find(row => row.key === key)?.ready ?? null
    setPrepared(available)
    if (!key || available) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const owner = await prepareShareOwner(key, current)
      if (!current()) return
      setPrepared(owner)
      if (!owner) setError('Could not load this destination owner.')
    } catch {
      if (current()) setError('Could not load this destination owner.')
    } finally {
      if (current()) setLoading(false)
    }
  }
  return (
    <Dialog title="Share to RChat" onClose={close}>
      <Stack gap="md">
        {content.text && (
          <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words">{content.text}</p>
        )}
        {content.files.length > 0 && (
          <p className="truncate">{content.files.map(f => f.name).join(', ')}</p>
        )}
        {owners.length ? (
          <>
            <Stack as="label" gap="2xs">
              As
              <select
                className={fieldCls}
                aria-label="As"
                value={selected?.key ?? ''}
                onChange={e => void select(e.target.value)}
              >
                <option value="">Choose an account or identity</option>
                {[...new Set(owners.map(o => o.origin))].map((origin, i) => (
                  <optgroup
                    key={origin}
                    label={
                      streamer || owners.some(o => o.origin === origin && o.streamer)
                        ? 'Instance ' + (i + 1)
                        : owners.find(o => o.origin === origin)!.group
                    }
                  >
                    {owners
                      .filter(o => o.origin === origin)
                      .map((o, n) => (
                        <option key={o.key} value={o.key}>
                          {streamer || o.streamer
                            ? (o.local ? 'P2P identity ' : 'Account ') + (n + 1)
                            : o.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Stack>
            {ready ? (
              <AccountProvider session={ready.account}>
                <P2pProvider identity={ready.identity}>
                  <Destinations
                    key={key + ready.account.renderKey}
                    owner={ready}
                    streamer={streamer}
                    content={content}
                    close={close}
                    valid={() =>
                      valid() &&
                      selection.current === mark &&
                      choices(liveSwitcherRows().groups).some(
                        row =>
                          row.key === key &&
                          row.ready?.account === ready.account &&
                          row.ready.identity === ready.identity
                      )
                    }
                  />
                </P2pProvider>
              </AccountProvider>
            ) : (
              <>
                {loading && <p role="status">Loading destinations…</p>}
                {error && <p role="alert">{error}</p>}
                {selected && !loading && (
                  <Button onClick={() => void select(key)}>Load destinations</Button>
                )}
                <Button onClick={close}>Cancel</Button>
              </>
            )}
          </>
        ) : (
          <>
            <p>Sign in to choose a destination.</p>
            <Button onClick={close}>Close</Button>
          </>
        )}
      </Stack>
    </Dialog>
  )
}
function waitsForLogin(pathname: string | null) {
  if (/^\/login\/?$/.test(pathname ?? '')) return false
  const account = client.shown()
  const state = account.store.getState()
  return (
    awaitingInstance(account.conn) ||
    (!state.token && !state.guest && !keptSession(account.conn, account.credentialTarget))
  )
}

export function ShareTarget() {
  const pathname = usePathname()
  const revision = useRef(0)
  const [received, setReceived] = useState<{ content: SharedContent; mark: number } | null>(null)
  // Once the startup redirect has settled, a route change must not cancel a destructive take.
  const [ready, setReady] = useState(false)
  const receive = (content: SharedContent) => setReceived({ content, mark: ++revision.current })
  useEffect(() => {
    if (
      (mobileOs() || new URLSearchParams(window.location.search).has('receive-share')) &&
      !waitsForLogin(pathname)
    )
      setReady(true)
  }, [pathname])
  useEffect(() => {
    if (!ready || !mobileOs()) return
    return watchIncomingShares(
      invoke,
      receive,
      message => client.shown().store.getState().setError(message),
      () => revision.current
    )
  }, [ready])
  const close = () => {
    revision.current++
    setReceived(null)
  }
  useEffect(() => {
    const localPane = (e: DragEvent) =>
      e.target instanceof Element &&
      !!e.target.closest('[data-share-drop-pane]') &&
      choices(liveSwitcherRows().groups).length === 1
    const onDrag = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') && !localPane(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      if (localPane(e)) return
      e.preventDefault()
      e.stopPropagation()
      receive({ text: '', files: Array.from(e.dataTransfer.files) })
    }
    window.addEventListener('dragenter', onDrag, true)
    window.addEventListener('dragover', onDrag, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragenter', onDrag, true)
      window.removeEventListener('dragover', onDrag, true)
    }
  }, [])
  useEffect(() => {
    if (!ready) return
    const url = new URL(window.location.href),
      ticket = url.searchParams.get('receive-share')
    const launched = revision.current
    let open = true,
      port: MessagePort | undefined
    const timer = time().after(0, async () => {
      if (!ticket || !navigator.serviceWorker) return
      const worker =
        navigator.serviceWorker.controller ?? (await navigator.serviceWorker.ready).active
      if (!open || !worker) return
      const channel = new MessageChannel()
      port = channel.port1
      port.onmessage = e => {
        port?.close()
        if (!open) return
        const page = new URL(window.location.href)
        if (page.searchParams.get('receive-share') === ticket) {
          page.searchParams.delete('receive-share')
          window.history.replaceState(window.history.state, '', page)
        }
        const payload = e.data
        if (
          launched === revision.current &&
          typeof payload?.text === 'string' &&
          Array.isArray(payload.files) &&
          payload.files.every((f: unknown) => f instanceof File)
        )
          receive(payload)
        else if (launched === revision.current)
          client
            .shown()
            .store.getState()
            .setError('This share expired or was already opened. Share it again.')
      }
      worker.postMessage({ kind: 'receive-share', ticket }, [channel.port2])
    })
    return () => {
      open = false
      timer()
      port?.close()
    }
  }, [ready])
  return received ? (
    <Picker
      key={received.mark}
      content={received.content}
      close={close}
      valid={() => revision.current === received.mark}
    />
  ) : null
}
