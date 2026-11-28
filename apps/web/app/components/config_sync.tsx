'use client'
import { instanceName } from '../lib/names'
import { Name } from './name'
import { Loaded, useAccountRequest } from './loaded'
import { RowsSkeleton } from './skeletons'
import { orMissing } from '../lib/api_errors'
import { routeOwnerFor } from '../lib/client/account_paths'
import { accountPath } from '../lib/view'
import { P2pProvider, useP2pApp, useP2p } from '../lib/client/p2p_react'
import type { P2pApp } from '../lib/p2p/app/runtime'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { Check, Copy, QrCode as QrIcon, Share2, Trash2 } from 'lucide-react'
import { encode } from 'uqr'
import { client } from '../lib/client/client'
import { useAccount } from '../lib/client/react'
import { errorText, useStore } from '../lib/store'
import { accountPrompt } from '../lib/features'
import { sharing } from '../lib/platform'
import { untilText } from '../lib/notify'
import type { ConfigShare } from '../lib/api'
import {
  EXPIRY_CHOICES,
  FILE_EXT,
  FILE_LIMITS,
  FILE_MAX,
  LINK_MAX,
  SECTIONS,
  TEXT_MAX,
  splitFile,
  buildConfig,
  configUrl,
  configPath,
  decodeConfig,
  decodeLink,
  describeChanges,
  encodeConfig,
  hasStashedConfig,
  linkDoc,
  parseConfigLink,
  presentSections,
  sectionOf,
  type ConfigDoc,
  type ConfigSource,
  type SectionKey,
} from '../lib/config_transfer'
import { Button, Cover, IconButton } from './controls'
import { Row, Stack, Surface } from './layout'
import { FieldError, LinkPage, fieldCls, sectionCls, useCopied } from './ui'
import { fmtSize } from '../lib/bytes'
import { type FilesPart } from '../lib/p2p/app'
import {
  Cancelled,
  filesHead,
  passProblem,
  percent,
  whileSlow,
  type FilesKey,
} from '../lib/p2p/transfer'
import { IdentityEnrollment } from './p2p/identity_enrollment'
import { p2pTrustText } from '../lib/add_instance'
import { shellInfo } from '../lib/platform'
import { P2pExportOption, P2pImport, SlowNote, type PassState } from './p2p/p2p_transfer'
import { useInstanceLabel } from './instance_badge'
import { time } from '../lib/platform/time'

const areaCls = `${fieldCls} w-full resize-none font-mono text-xs break-all md:text-xs`

// A secret stays covered until pressed, so it never shows by accident: in streamer mode always,
// and outside it too when `always`. Copy and share buttons next to it still work.
function StreamerCover({
  what,
  always = false,
  children,
}: {
  what: string
  always?: boolean
  children: ReactNode
}) {
  const streamer = useStore(s => s.streamer)
  const [open, setOpen] = useState(false)
  if ((!streamer && !always) || open) return <>{children}</>
  return (
    <Cover
      data-streamer-cover
      aria-label={`Show ${what}`}
      onClick={() => setOpen(true)}
      place="flex-1"
    >
      {streamer ? `Hidden in streamer mode. Show ${what}` : `Show ${what}`}
    </Cover>
  )
}

// Dark modules on white with a 4-module quiet zone in both themes, so all scanners can read it.
export function QrCode({
  text,
  label,
  wide = false,
}: {
  text: string
  label: string
  wide?: boolean
}) {
  const qr = useMemo(() => encode(text, { ecc: 'M', border: 4 }), [text])
  const path = useMemo(() => {
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      })
    )
    return d
  }, [qr])
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr={text}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className={`block h-auto w-full rounded-lg ${wide ? 'max-w-72' : 'max-w-56'}`}
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, flashCopied] = useCopied()
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={label}
      tooltip={copied ? 'Copied' : label}
      size="sm"
      onClick={() =>
        void sharing()
          .copyText(text)
          .then(ok => ok && flashCopied())
      }
    />
  )
}

// The P2P rail's order and folders go along with the layout (their own store).
const useConfigSource = (): ConfigSource => {
  const src = useInstanceSource()
  const p2pRail = useP2p(s => s.layout.servers)
  return useMemo(
    () =>
      src.layout && p2pRail.length ? { ...src, layout: { ...src.layout, p2p: p2pRail } } : src,
    [src, p2pRail]
  )
}

const useInstanceSource = (): ConfigSource =>
  useStore(
    useShallow(s => ({
      theme: s.theme,
      streamer: s.streamer,
      appearOffline: s.me ? s.me.appear_offline : null,
      layout: s.me || s.guest ? s.layout : null,
      notify: s.me || s.guest ? s.notifyPrefs : null,
      emoji: s.me ? s.emoji : null,
      calls: s.me ? s.callRoute : null,
      typing: s.me || s.guest ? s.typingOn : null,
      animations: s.me || s.guest ? s.anim : null,
      profanity: s.me || s.guest ? s.profanityOn : null,
      spoilers: s.me || s.guest ? s.showSpoilers : null,
      relays: s.me ? s.relayPrefs : null,
    }))
  )

const useAvailable = () => {
  const me = useStore(s => s.me !== null)
  const guest = useStore(s => s.guest)
  return (key: SectionKey) => {
    const section = sectionOf(key)
    if (section.account) return me
    return section.device || me || guest
  }
}

// One checkbox row per section in `doc`, showing what changes, and Apply.
function ImportPreview({
  doc,
  onDone,
  identity,
  loggedOut = false,
}: {
  doc: ConfigDoc
  onDone: (applied: boolean, error: string | null) => void
  identity: P2pApp | null
  loggedOut?: boolean
}) {
  const source = useConfigSource()
  const available = useAvailable()
  const applyConfig = useStore(s => s.applyConfig)
  const changes = useMemo(() => describeChanges(doc, source), [doc, source])
  const usable = (key: SectionKey) => available(key) || (loggedOut && !sectionOf(key).device)
  const [picked, setPicked] = useState<Set<SectionKey>>(
    () => new Set(changes.filter(c => !c.same && usable(c.key)).map(c => c.key))
  )
  const [busy, setBusy] = useState(false)
  const later = [...picked].some(k => loggedOut && !sectionOf(k).device)
  const toggle = (key: SectionKey) =>
    setPicked(cur => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const apply = async () => {
    setBusy(true)
    const error = await applyConfig(doc, [...picked], identity)
    setBusy(false)
    onDone(error === null, error)
  }
  if (!changes.length) return <p className="text-sm text-on-surface-variant">Nothing to import.</p>
  return (
    <Stack gap="md">
      <Stack as="ul" gap="2xs" aria-label="What will change">
        {changes.map(c => {
          const ok = usable(c.key)
          const note = !ok
            ? 'Needs an account'
            : loggedOut && !sectionOf(c.key).device
              ? 'Applies after you log in'
              : c.same
                ? 'Same as now'
                : null
          return (
            <li key={c.key}>
              <Surface
                as="label"
                pad="md"
                inset="bar"
                gap="md"
                row
                tone="plain"
                radius="lg"
                align="start"
                look={`hover:bg-surface-container-high ${ok ? '' : 'opacity-60'}`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(c.key)}
                  disabled={!ok}
                  onChange={() => toggle(c.key)}
                  className="accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-on-surface">{c.label}</span>
                  <span className="block text-xs break-words text-on-surface-variant">
                    {c.same || c.now === null ? c.next : `${c.now} → ${c.next}`}
                    {note && ` · ${note}`}
                  </span>
                </span>
              </Surface>
            </li>
          )
        })}
      </Stack>
      <p className="text-xs text-on-surface-variant">
        Servers and DMs this account isn&apos;t in are skipped.
      </p>
      <Row gap="sm" wrap>
        <Button
          variant="filled"
          size="md"
          disabled={busy || picked.size === 0}
          onClick={() => void apply()}
        >
          {later ? 'Apply and log in' : 'Apply'}
        </Button>
      </Row>
    </Stack>
  )
}

function IncludeList({
  include,
  onToggle,
}: {
  include: Set<SectionKey>
  onToggle: (key: SectionKey) => void
}) {
  const available = useAvailable()
  return (
    <Stack as="fieldset" gap="2xs">
      <legend className="text-sm text-on-surface-variant">Include</legend>
      {SECTIONS.map(s => {
        const ok = available(s.key)
        return (
          <Row as="label" key={s.key} gap="sm" title={ok ? undefined : 'Needs an account'}>
            <input
              type="checkbox"
              checked={ok && include.has(s.key)}
              disabled={!ok}
              onChange={() => onToggle(s.key)}
              className={`accent-primary ${ok ? '' : 'opacity-60'}`}
            />
            <span className={`text-sm ${ok ? '' : 'opacity-60'}`}>{s.label}</span>
          </Row>
        )
      })}
    </Stack>
  )
}

const useExport = (include: Set<SectionKey>) => {
  const source = useConfigSource()
  return useMemo(() => buildConfig(source, include), [source, include])
}

const FILE_NAME = `rchat-config${FILE_EXT}`

type SavePicker = (opts: { suggestedName: string }) => Promise<{
  createWritable: () => Promise<{
    write: (data: BufferSource | Blob | string) => Promise<void>
    close: () => Promise<void>
    abort: () => Promise<void>
  }>
}>

// The config text, then the P2P files, one block at a time: straight to disk where the browser
// lets the page write a file, otherwise into a Blob made of per-block Blobs (which the browser
// keeps in its own storage, not the page's memory). False when the user cancelled.
const downloadWithFiles =
  (identity: P2pApp, valid: () => boolean) =>
  async (text: string, fk: FilesKey, progress: (n: number) => void): Promise<boolean> => {
    const { p2pTransfer } = identity

    const check = () => {
      if (!valid()) throw new Cancelled()
    }
    check()
    const onBytes = (done: number, total: number) => {
      if (valid()) progress(total ? done / total : 1)
    }
    const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
    if (typeof picker === 'function') {
      let handle: Awaited<ReturnType<SavePicker>> | null = null
      try {
        handle = await picker({ suggestedName: FILE_NAME })
      } catch (e) {
        if ((e as { name?: unknown })?.name === 'AbortError') return false
      }
      check()
      if (handle) {
        const w = await handle.createWritable()
        try {
          check()
          await w.write(`${text}\n`)
          check()
          await p2pTransfer.writeFiles(
            fk,
            part => {
              check()
              return w.write(part as BufferSource)
            },
            onBytes
          )
          check()
          await w.close()
          return true
        } catch (e) {
          await w.abort().catch(() => {})
          throw e
        }
      }
    }
    const parts: BlobPart[] = [`${text}\n`]
    await p2pTransfer.writeFiles(
      fk,
      async part => {
        check()
        parts.push(new Blob([part as BlobPart]))
      },
      onBytes
    )
    check()
    sharing(identity.owner, valid).saveBlob(
      FILE_NAME,
      new Blob(parts, { type: 'application/octet-stream' })
    )
    return true
  }

// `p2p`: the passphrase when the P2P identity goes in too. That export is made on request (the
// key derivation takes a moment), the plain one whenever the choice changes.
function ExportBlock({
  doc,
  p2p,
  files = false,
}: {
  doc: ConfigDoc
  p2p: string | null | false
  files?: boolean
}) {
  const identity = useP2pApp()

  const acct = useAccount()
  const [result, setResult] = useState<{
    text: string
    attachments?: { identity: P2pApp; key: FilesKey; valid: () => boolean }
  } | null>(null)
  const text = result?.text ?? ''
  const attachments = result?.attachments
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState<number | null>(null)
  // The part of the key derivation done, where it is slow enough to show and to stop.
  const [part, setPart] = useState<number | null>(null)
  const [late, setLate] = useState(false)
  const stop = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    let live = true
    setResult(null)
    setBusy(false)
    setWriting(null)
    setError(null)
    if (p2p === false) void encodeConfig(doc).then(t => live && setResult({ text: t }))
    return () => {
      live = false
      stop.current?.abort()
    }
  }, [doc, p2p, files, identity])
  const create = async (pass: string) => {
    if (!identity) return
    const ctl = new AbortController()
    stop.current?.abort()
    stop.current = ctl
    const mark = acct.lifetime.sessionMark()
    const valid = () =>
      !ctl.signal.aborted &&
      acct.lifetime.sessionMark() === mark &&
      acct.identities.get(identity.localId) === identity
    setBusy(true)
    setError(null)
    setPart(null)
    setLate(false)
    try {
      const watch = {
        progress: (n: number) => {
          if (valid()) setPart(n)
        },
        signal: ctl.signal,
      }
      const made = await whileSlow(
        identity.p2pTransfer.exportSection(pass, undefined, files, watch),
        on => valid() && setLate(on)
      )
      if (!valid()) return
      const t = await encodeConfig({ ...doc, p2p: made.section })
      if (!valid()) return
      if (t.length > FILE_MAX) setError(`Too large to export (over ${fmtSize(FILE_MAX)})`)
      else {
        setResult({
          text: t,
          attachments: made.files ? { identity, key: made.files, valid } : undefined,
        })
      }
    } catch (e) {
      if (valid() && !(e instanceof Cancelled)) setError(errorText(e))
    } finally {
      if (stop.current === ctl) {
        setBusy(false)
        setPart(null)
      }
    }
  }
  const fileOnly = text.length > TEXT_MAX || !!attachments
  const save = async () => {
    if (!attachments)
      return sharing(acct).saveFile(FILE_NAME, `${text}\n`, 'application/octet-stream')
    if (!attachments.valid()) return
    setError(null)
    setWriting(0)
    try {
      await downloadWithFiles(attachments.identity, attachments.valid)(
        text,
        attachments.key,
        setWriting
      )
    } catch (e) {
      if (attachments.valid()) setError(errorText(e))
    } finally {
      if (attachments.valid()) setWriting(null)
    }
  }
  return (
    <Stack gap="sm">
      {p2p !== false && !text && (
        <Row gap="sm" wrap>
          <Button
            variant="filled"
            size="md"
            disabled={p2p === null || busy}
            onClick={() => p2p && void create(p2p)}
          >
            {!busy
              ? 'Create export'
              : part === null
                ? 'Encrypting…'
                : `Encrypting ${percent(part)}`}
          </Button>
          {busy && part !== null && part < 1 && (
            <Button size="md" onClick={() => stop.current?.abort()}>
              Cancel
            </Button>
          )}
          {busy && part !== null && late && (
            <div className="w-full">
              <SlowNote />
            </div>
          )}
        </Row>
      )}
      {attachments && text ? (
        <p className="text-xs text-on-surface-variant">
          With attachments, the export is a file only. Copying it as text or a QR code leaves them
          out.
        </p>
      ) : fileOnly ? (
        <p className="text-xs text-on-surface-variant">
          This export is {fmtSize(text.length)}, too large to copy as text. Download the file
          instead.
        </p>
      ) : (
        (p2p === false || text) && (
          <Row gap="2xs" align="start">
            <StreamerCover what="config string" always>
              <textarea
                readOnly
                rows={3}
                value={text}
                aria-label="Config string"
                onFocus={e => e.currentTarget.select()}
                className={areaCls}
              />
            </StreamerCover>
            <CopyButton text={text} label="Copy config string" />
          </Row>
        )
      )}
      <FieldError message={error} />
      {(p2p === false || text) && (
        <div>
          <Button
            variant={fileOnly ? 'filled' : 'text'}
            size="md"
            disabled={!text || writing !== null}
            onClick={() => void save()}
          >
            {writing !== null ? `Writing files ${Math.floor(writing * 100)}%` : 'Download file'}
          </Button>
        </div>
      )}
    </Stack>
  )
}

function ShareBlock({ doc }: { doc: ConfigDoc }) {
  const { api, shareOrigin } = useAccount()
  const { label } = useInstanceLabel()
  const [links, setLinks] = useState<ConfigShare[] | null>(null)
  const [expiry, setExpiry] = useState(EXPIRY_CHOICES[2].seconds)
  const [shown, setShown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => time().now())
  const streamer = useStore(s => s.streamer)

  const load = useCallback(async () => {
    try {
      const list = await api.configShares()
      setLinks(list)
      setNow(time().now())
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const blob = await encodeConfig(linkDoc(doc))
      if (blob.length > LINK_MAX) {
        setError('Too large for a link. Leave out some sections or use the text below')
        return
      }
      const made = await api.createConfigShare(blob, expiry)
      setShown(made.id)
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setError(null)
    try {
      await api.deleteConfigShare(id)
      if (shown === id) setShown(null)
    } catch (e) {
      setError(errorText(e))
    }
    await load()
  }

  const shownUrl = shown ? configUrl(shown, shareOrigin) : null
  const empty = presentSections(linkDoc(doc)).length === 0

  return (
    <Stack gap="md">
      <Row gap="sm" align="end" wrap>
        <label className="min-w-40 flex-1">
          <Stack as="span" gap="2xs">
            <span className="text-xs text-on-surface-variant">Expires after</span>
            <select
              aria-label="Expires after"
              value={expiry}
              onChange={e => setExpiry(Number(e.target.value))}
              className={`${fieldCls} w-full bg-surface-container-high`}
            >
              {EXPIRY_CHOICES.map(c => (
                <option key={c.seconds} value={c.seconds}>
                  {c.label}
                </option>
              ))}
            </select>
          </Stack>
        </label>
        <Button variant="filled" size="md" disabled={busy || empty} onClick={() => void create()}>
          Create link
        </Button>
      </Row>
      <p className="text-xs text-on-surface-variant">
        Anyone with the link can see the included settings, like the servers you are in and who you
        message, until it expires. <Name of={instanceName(label)} /> stores them as readable text.
        Links never include P2P servers or P2P settings.
      </p>
      {empty && <p className="text-xs text-on-surface-variant">Include at least one section.</p>}
      <FieldError message={error} />
      {shownUrl && (
        <Surface pad="lg" gap="md" align="center">
          <StreamerCover key={shownUrl} what="QR code and link">
            <QrCode text={shownUrl} label="QR code of the config link" />
            <p className="text-center text-xs text-on-surface-variant">
              Scan to open on your phone
            </p>
          </StreamerCover>
          <Row gap="2xs" place="w-full">
            {streamer ? (
              <span className="min-w-0 flex-1 truncate text-sm text-on-surface-variant">
                Config link
              </span>
            ) : (
              <input
                readOnly
                value={shownUrl}
                aria-label="Config link"
                onFocus={e => e.currentTarget.select()}
                className={`${fieldCls} font-mono text-xs md:text-xs`}
              />
            )}
            <CopyButton text={shownUrl} label="Copy link" />
            {sharing().canShare() && (
              <IconButton
                icon={Share2}
                label="Share link"
                size="sm"
                onClick={() => void sharing().share({ title: 'Config', url: shownUrl })}
              />
            )}
          </Row>
        </Surface>
      )}
      {links !== null && links.length > 0 && (
        <Stack gap="2xs">
          <p className="text-sm text-on-surface-variant">Active links</p>
          <Stack as="ul" gap="2xs">
            {links.map((l, i) => (
              <Surface as="li" key={l.id} pad="md" tone="low" radius="lg">
                <Row gap="sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-on-surface">
                      {streamer ? `Link ${i + 1}` : l.id}
                    </span>
                    <span className="block text-xs text-on-surface-variant">
                      Active {untilText(l.expires_at * 1000, now)}
                    </span>
                  </span>
                  <IconButton
                    icon={QrIcon}
                    label={shown === l.id ? 'Hide QR code' : 'Show QR code'}
                    size="sm"
                    pressed={shown === l.id}
                    onClick={() => setShown(shown === l.id ? null : l.id)}
                  />
                  <CopyButton text={configUrl(l.id, shareOrigin)} label="Copy link" />
                  <IconButton
                    icon={Trash2}
                    label="Revoke link"
                    size="sm"
                    tone="danger"
                    onClick={() => void revoke(l.id)}
                  />
                </Row>
              </Surface>
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}

function ImportBlock() {
  const identity = useP2pApp()
  const p2p = identity?.p2p

  const { api, shareOrigin, lifetime } = useAccount()
  const mark = lifetime.sessionMark()
  const [text, setText] = useState('')
  const [result, setResult] = useState<{
    doc: ConfigDoc
    identity: P2pApp | null
    files: FilesPart | null
    request: number
    mark: object
  } | null>(null)
  const latest = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const current = (request: number) => request === latest.current && mark === lifetime.sessionMark()
  const preview = async (
    raw: string,
    request: number,
    file = false,
    files: FilesPart | null = null
  ) => {
    setError(null)
    setDone(null)
    setResult(null)
    if (!file && raw.length > TEXT_MAX) {
      setError('Too long to paste. Use Import file instead')
      return
    }
    const id = file ? null : parseConfigLink(raw, shareOrigin)
    let input = raw
    if (id) {
      try {
        input = (await api.configShare(id)).blob
      } catch {
        if (current(request)) setError('This link has expired or was revoked')
        return
      }
    }
    const decoded = await (id
      ? decodeLink(input)
      : decodeConfig(input, time().now(), file ? FILE_LIMITS : undefined))
    if (!current(request)) return
    if (!decoded.ok) setError(decoded.error)
    else setResult({ identity, files, request, mark, doc: decoded.doc })
  }

  // Only the first line is read now; P2P files after it are streamed when they are imported.
  const openFile = async () => {
    const request = ++latest.current
    setError(null)
    const file = await sharing().openBlob(`${FILE_EXT},.txt,text/plain,application/octet-stream`)
    if (file === null) return
    const split = await splitFile(file).catch(() => null)
    if (!current(request)) return
    if (!split) return setError(`Choose a file under ${fmtSize(FILE_MAX)}`)
    const content = split.text.trim()
    const head = await filesHead(split.rest, p2p?.limits().transfer).catch(() => null)
    if (!current(request)) return
    // Large files stay out of the text box; it would only slow the page down.
    setText(content.length > TEXT_MAX || head ? '' : content)
    await preview(content, request, true, head ? { blob: split.rest, head } : null)
  }

  return (
    <Stack gap="sm">
      <textarea
        rows={3}
        value={text}
        placeholder="Paste a config string or link"
        aria-label="Config string to import"
        onChange={e => {
          setText(e.target.value)
          ++latest.current
          setResult(null)
          setError(null)
        }}
        className={areaCls}
      />
      <Row gap="sm" wrap>
        <Button
          variant="filled"
          size="md"
          disabled={!text.trim()}
          onClick={() => void preview(text, ++latest.current)}
        >
          Preview
        </Button>
        <Button size="md" onClick={() => void openFile()}>
          Import file
        </Button>
      </Row>
      <FieldError message={error} />
      {done && (
        <p role="status" className="text-sm text-on-surface-variant">
          {done}
        </p>
      )}
      {result && result.mark === mark && (
        <P2pProvider identity={result.identity}>
          <ImportSections
            key={result.request}
            {...result}
            onDone={(applied, err) => {
              if (!current(result.request)) return
              if (err) setError(err)
              if (applied) {
                setResult(null)
                setText('')
                setDone('Config applied')
              }
            }}
          />
        </P2pProvider>
      )}
    </Stack>
  )
}

function ImportSections({
  doc,
  identity,
  files,
  onDone,
}: {
  doc: ConfigDoc
  identity: P2pApp | null
  files: FilesPart | null
  onDone: (applied: boolean, error: string | null) => void
}) {
  const account = useAccount()
  const [importMode, setImportMode] = useState<'choose' | 'existing' | 'new'>('choose')
  const [trusted, setTrusted] = useState(false)
  const p2pOn = useP2p(s => s.account !== null)
  return (
    <>
      {doc.p2p &&
        p2pOn &&
        (importMode === 'new' ? (
          <IdentityEnrollment
            account={account}
            imported={{ section: doc.p2p, files }}
            cancel={() => setImportMode('choose')}
          />
        ) : importMode === 'existing' && trusted ? (
          <P2pImport section={doc.p2p} files={files} />
        ) : importMode === 'existing' ? (
          <Stack gap="sm">
            <strong>Keep your P2P identity in an app you trust</strong>
            <p>
              {p2pTrustText(
                shellInfo() || typeof window === 'undefined' ? null : window.location.host
              )}
            </p>
            <p>
              Attach to{' '}
              <span className="streamer">
                {account.store.getState().me?.username}@{new URL(account.conn.origin).host}
              </span>
            </p>
            <Button variant="filled" size="md" onClick={() => setTrusted(true)}>
              I trust this app
            </Button>
            <Button size="md" onClick={() => setImportMode('choose')}>
              Cancel
            </Button>
          </Stack>
        ) : (
          <Row gap="sm" wrap>
            {identity?.p2p.hasData(account.store.getState().me?.username ?? '') && (
              <Button onClick={() => setImportMode('existing')}>
                Import into the selected identity
              </Button>
            )}
            <Button onClick={() => setImportMode('new')}>Attach as a new P2P identity</Button>
          </Row>
        ))}
      {(!doc.p2p || !p2pOn || presentSections(doc).length > 0) && (
        <ImportPreview identity={identity} doc={doc} onDone={onDone} />
      )}
    </>
  )
}

function IdentityExport({ doc }: { doc: ConfigDoc }) {
  const identity = useP2pApp()
  const p2p = identity?.p2p

  const me = useStore(s => s.me !== null)
  const hasP2p = useP2p(s => s.ik !== null && s.movedAt === null) && me
  const [withP2p, setWithP2p] = useState(false)
  const [pass, setPass] = useState<PassState>({ pass: '', again: '', files: false })
  const p2pPass =
    !hasP2p || !withP2p
      ? false
      : passProblem(pass.pass, pass.again, p2p?.limits().transfer)
        ? null
        : pass.pass
  return (
    <Stack as="section" gap="md">
      <p className={sectionCls}>Export</p>
      {hasP2p && (
        <P2pExportOption
          on={withP2p}
          onToggle={on => {
            setWithP2p(on)
            if (!on) setPass({ pass: '', again: '', files: false })
          }}
          value={pass}
          onChange={setPass}
        />
      )}
      <ExportBlock doc={doc} p2p={p2pPass} files={withP2p && pass.files} />
    </Stack>
  )
}

export function ConfigSyncSection() {
  const identity = useP2pApp()
  const account = useAccount()
  const mark = account.lifetime.sessionMark()
  const slot = useRef({ identity, mark, key: 0 })
  if (slot.current.identity !== identity || slot.current.mark !== mark)
    slot.current = { identity, mark, key: slot.current.key + 1 }
  const me = useStore(s => s.me !== null)
  const ask = useStore(s => accountPrompt(s.settings))
  const [include, setInclude] = useState<Set<SectionKey>>(() => new Set(SECTIONS.map(s => s.key)))
  const doc = useExport(include)
  const toggle = (key: SectionKey) =>
    setInclude(cur => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <Stack gap="2xl">
      <Stack as="section" gap="lg">
        <p className="text-sm text-on-surface-variant">
          Move your settings and layout to another device or account. Passwords, sessions, drafts
          and files are never included.
        </p>
        <IncludeList include={include} onToggle={toggle} />
      </Stack>
      <section>
        <p className={sectionCls}>Share link</p>
        {me ? (
          <ShareBlock doc={doc} />
        ) : (
          <p className="text-sm text-on-surface-variant">
            {ask} to share links. You can still copy the text below.
          </p>
        )}
      </section>
      <IdentityExport key={slot.current.key} doc={doc} />
      <section>
        <p className={sectionCls}>Import</p>
        <ImportBlock />
      </section>
    </Stack>
  )
}

interface SharedConfig {
  doc: ConfigDoc
  expiresAt: number
}

function LinkCard({ id }: { id: string }) {
  const account = useAccount()
  const selected = useP2pApp()
  const [identity] = useState(selected)
  const { handoff } = account
  const mark = account.lifetime.sessionMark()
  const router = useRouter()
  const showToast = useStore(s => s.showToast)
  const authed = useStore(s => s.me !== null || s.guest)
  const closeConfigLink = useStore(s => s.closeConfigLink)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useAccountRequest<SharedConfig | null>(
    api =>
      api.configShare(id).then(async res => {
        const decoded = await decodeLink(res.blob)
        if (!decoded.ok) throw new Error(decoded.error)
        return { doc: decoded.doc, expiresAt: res.expires_at }
      }, orMissing(null)),
    [id]
  )

  const current = () =>
    mark === account.lifetime.sessionMark() && account.store.getState().configLink === id
  const logIn = () => {
    if (current() && client.shown() === account)
      router.push(
        '/login/?next=' + encodeURIComponent(accountPath(configPath(id), routeOwnerFor(account)))
      )
  }
  const title = <h1 className="text-xl font-medium text-on-surface">Shared config</h1>

  return (
    <div className="w-full max-w-md rounded-3xl bg-surface-container shadow-elevation-2">
      <Surface pad="xl" gap="lg" tone="plain">
        <Loaded
          load={load}
          what="the shared config"
          skeleton={
            <Stack gap="md">
              {title}
              <RowsSkeleton rows={3} label="Loading the shared config" />
            </Stack>
          }
        >
          {shared =>
            shared === null ? (
              <Stack gap="md">
                {title}
                <p className="text-sm text-on-surface-variant">
                  This link has expired or was revoked.
                </p>
              </Stack>
            ) : (
              <>
                <Stack gap="2xs">
                  {title}
                  <p className="text-sm text-on-surface-variant">
                    Pick what to apply on this device. Link active{' '}
                    {untilText(shared.expiresAt * 1000, time().now())}.
                  </p>
                </Stack>
                {done ? (
                  <p role="status" className="text-sm text-on-surface">
                    {done}
                  </p>
                ) : (
                  <P2pProvider identity={identity}>
                    <ImportPreview
                      identity={identity}
                      doc={shared.doc}
                      loggedOut={!authed}
                      onDone={(applied, err) => {
                        if (!current()) return
                        setError(err)
                        if (!applied) return
                        if (authed) {
                          showToast('Config applied')
                          closeConfigLink()
                        } else if (hasStashedConfig(handoff)) logIn()
                        else setDone('Applied on this device')
                      }}
                    />
                  </P2pProvider>
                )}
                <FieldError message={error} />
              </>
            )
          }
        </Loaded>
        <Row gap="sm" wrap>
          {!authed && <Button onClick={logIn}>Log in</Button>}
          {authed && <Button onClick={closeConfigLink}>Close</Button>}
        </Row>
      </Surface>
    </div>
  )
}

export function ConfigLinkPage() {
  const id = useStore(s => s.configLink)
  const closeConfigLink = useStore(s => s.closeConfigLink)
  if (!id) return null
  return (
    <LinkPage closeTitle="Close" onClose={closeConfigLink}>
      <LinkCard key={id} id={id} />
    </LinkPage>
  )
}
