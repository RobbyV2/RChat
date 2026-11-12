'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { Check, Copy, Eye, QrCode as QrIcon, Share2, Trash2 } from 'lucide-react'
import { encode } from 'uqr'
import { api, shareOrigin } from '../lib/instances'
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
import { FieldError, LinkPage, fieldCls, filledBtn, sectionCls, textBtn, useCopied } from './ui'
import { fmtSize } from '../lib/bytes'
import { p2pTransfer, useP2p, type FilesPart } from '../lib/p2p/app'
import {
  Cancelled,
  filesHead,
  passProblem,
  percent,
  whileSlow,
  type FilesKey,
} from '../lib/p2p/transfer'
import { P2pExportOption, P2pImport, SlowNote, type PassState } from './p2p/p2p_transfer'

const iconBtn =
  'rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface disabled:pointer-events-none disabled:opacity-40'

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
    <button
      type="button"
      title={`Show ${what}`}
      aria-label={`Show ${what}`}
      data-streamer-cover
      onClick={() => setOpen(true)}
      className="flex min-h-12 w-full flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-outline-variant px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
    >
      <Eye size={16} />
      {streamer ? `Hidden in streamer mode. Show ${what}` : `Show ${what}`}
    </button>
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
    <button
      type="button"
      title={copied ? 'Copied' : label}
      aria-label={label}
      onClick={() =>
        void sharing()
          .copyText(text)
          .then(ok => ok && flashCopied())
      }
      className={iconBtn}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
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
  loggedOut = false,
}: {
  doc: ConfigDoc
  onDone: (applied: boolean, error: string | null) => void
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
    const error = await applyConfig(doc, [...picked])
    setBusy(false)
    onDone(error === null, error)
  }
  if (!changes.length) return <p className="text-sm text-on-surface-variant">Nothing to import.</p>
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1" aria-label="What will change">
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
              <label
                className={`flex items-start gap-3 rounded-xl px-3 py-2 hover:bg-surface-container-high ${ok ? '' : 'opacity-60'}`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(c.key)}
                  disabled={!ok}
                  onChange={() => toggle(c.key)}
                  className="mt-1 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-on-surface">{c.label}</span>
                  <span className="block text-xs break-words text-on-surface-variant">
                    {c.same || c.now === null ? c.next : `${c.now} → ${c.next}`}
                    {note && ` · ${note}`}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <p className="px-3 text-xs text-on-surface-variant">
        Servers and DMs this account isn&apos;t in are skipped.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || picked.size === 0}
          onClick={() => void apply()}
          className={filledBtn}
        >
          {later ? 'Apply and log in' : 'Apply'}
        </button>
      </div>
    </div>
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
    <fieldset className="flex flex-col gap-1">
      <legend className="pb-1 text-sm text-on-surface-variant">Include</legend>
      {SECTIONS.map(s => {
        const ok = available(s.key)
        return (
          <label
            key={s.key}
            title={ok ? undefined : 'Needs an account'}
            className={`flex items-center gap-2 text-sm ${ok ? '' : 'opacity-60'}`}
          >
            <input
              type="checkbox"
              checked={ok && include.has(s.key)}
              disabled={!ok}
              onChange={() => onToggle(s.key)}
              className="accent-primary"
            />
            {s.label}
          </label>
        )
      })}
    </fieldset>
  )
}

const useExport = (include: Set<SectionKey>) => {
  const source = useConfigSource()
  return useMemo(() => buildConfig(source, include), [source, include])
}

const FILE_NAME = `rchat-config${FILE_EXT}`

const download = (text: string) =>
  sharing().saveFile(FILE_NAME, `${text}\n`, 'application/octet-stream')

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
const downloadWithFiles = async (
  text: string,
  fk: FilesKey,
  progress: (n: number) => void
): Promise<boolean> => {
  const onBytes = (done: number, total: number) => progress(total ? done / total : 1)
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (typeof picker === 'function') {
    let handle: Awaited<ReturnType<SavePicker>> | null = null
    try {
      handle = await picker({ suggestedName: FILE_NAME })
    } catch (e) {
      if ((e as { name?: unknown })?.name === 'AbortError') return false
    }
    if (handle) {
      const w = await handle.createWritable()
      try {
        await w.write(`${text}\n`)
        await p2pTransfer.writeFiles(fk, part => w.write(part as BufferSource), onBytes)
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
    async part => void parts.push(new Blob([part as BlobPart])),
    onBytes
  )
  sharing().saveBlob(FILE_NAME, new Blob(parts, { type: 'application/octet-stream' }))
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
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when the P2P files go too: then the export is a file only.
  const [filesKey, setFilesKey] = useState<FilesKey | null>(null)
  const [writing, setWriting] = useState<number | null>(null)
  // The part of the key derivation done, where it is slow enough to show and to stop.
  const [part, setPart] = useState<number | null>(null)
  const [late, setLate] = useState(false)
  const stop = useRef<AbortController | null>(null)
  useEffect(() => {
    let live = true
    setText('')
    setFilesKey(null)
    setError(null)
    if (p2p === false) void encodeConfig(doc).then(t => live && setText(t))
    return () => {
      live = false
      stop.current?.abort()
    }
  }, [doc, p2p, files])
  const create = async (pass: string) => {
    const ctl = new AbortController()
    stop.current = ctl
    setBusy(true)
    setError(null)
    setPart(null)
    try {
      const watch = { progress: setPart, signal: ctl.signal }
      const made = await whileSlow(
        p2pTransfer.exportSection(pass, undefined, files, watch),
        on => stop.current === ctl && setLate(on)
      )
      if (ctl.signal.aborted) return
      const t = await encodeConfig({ ...doc, p2p: made.section })
      if (t.length > FILE_MAX) setError(`Too large to export (over ${fmtSize(FILE_MAX)})`)
      else {
        setText(t)
        setFilesKey(made.files)
      }
    } catch (e) {
      if (!(e instanceof Cancelled)) setError(errorText(e))
    } finally {
      if (stop.current === ctl) {
        setBusy(false)
        setPart(null)
      }
    }
  }
  const fileOnly = text.length > TEXT_MAX || filesKey !== null
  const save = async () => {
    if (!filesKey) return download(text)
    setError(null)
    setWriting(0)
    try {
      await downloadWithFiles(text, filesKey, setWriting)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setWriting(null)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {p2p !== false && !text && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={p2p === null || busy}
            onClick={() => p2p && void create(p2p)}
            className={filledBtn}
          >
            {!busy
              ? 'Create export'
              : part === null
                ? 'Encrypting…'
                : `Encrypting ${percent(part)}`}
          </button>
          {busy && part !== null && part < 1 && (
            <button type="button" onClick={() => stop.current?.abort()} className={textBtn}>
              Cancel
            </button>
          )}
          {busy && part !== null && late && (
            <div className="w-full">
              <SlowNote />
            </div>
          )}
        </div>
      )}
      {filesKey && text ? (
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
          <div className="flex items-start gap-1">
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
          </div>
        )
      )}
      <FieldError message={error} />
      {(p2p === false || text) && (
        <div>
          <button
            type="button"
            disabled={!text || writing !== null}
            onClick={() => void save()}
            className={fileOnly ? filledBtn : textBtn}
          >
            {writing !== null ? `Writing files ${Math.floor(writing * 100)}%` : 'Download file'}
          </button>
        </div>
      )}
    </div>
  )
}

function ShareBlock({ doc }: { doc: ConfigDoc }) {
  const [links, setLinks] = useState<ConfigShare[] | null>(null)
  const [expiry, setExpiry] = useState(EXPIRY_CHOICES[2].seconds)
  const [shown, setShown] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const streamer = useStore(s => s.streamer)

  const load = useCallback(async () => {
    try {
      const list = await api.configShares()
      setLinks(list)
      setNow(Date.now())
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

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

  const shownUrl = shown ? configUrl(shown) : null
  const empty = presentSections(linkDoc(doc)).length === 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-40 flex-1">
          <span className="block pb-1 text-xs text-on-surface-variant">Expires after</span>
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
        </label>
        <button
          type="button"
          disabled={busy || empty}
          onClick={() => void create()}
          className={filledBtn}
        >
          Create link
        </button>
      </div>
      <p className="text-xs text-on-surface-variant">
        Anyone with the link can see the included settings, like the servers you are in and who you
        message, until it expires. This instance stores them as readable text. Links never include
        P2P servers or P2P settings.
      </p>
      {empty && <p className="text-xs text-on-surface-variant">Include at least one section.</p>}
      <FieldError message={error} />
      {shownUrl && (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface-container-high p-4">
          <StreamerCover key={shownUrl} what="QR code and link">
            <QrCode text={shownUrl} label="QR code of the config link" />
            <p className="text-center text-xs text-on-surface-variant">
              Scan to open on your phone
            </p>
          </StreamerCover>
          <div className="flex w-full items-center gap-1">
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
              <button
                type="button"
                title="Share link"
                aria-label="Share link"
                onClick={() => void sharing().share({ title: 'Config', url: shownUrl })}
                className={iconBtn}
              >
                <Share2 size={16} />
              </button>
            )}
          </div>
        </div>
      )}
      {links !== null && links.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-on-surface-variant">Active links</p>
          <ul className="flex flex-col gap-1">
            {links.map((l, i) => (
              <li
                key={l.id}
                className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-on-surface">
                    {streamer ? `Link ${i + 1}` : l.id}
                  </span>
                  <span className="block text-xs text-on-surface-variant">
                    Active {untilText(l.expires_at * 1000, now)}
                  </span>
                </span>
                <button
                  type="button"
                  title={shown === l.id ? 'Hide QR code' : 'Show QR code'}
                  aria-label={shown === l.id ? 'Hide QR code' : 'Show QR code'}
                  aria-pressed={shown === l.id}
                  onClick={() => setShown(shown === l.id ? null : l.id)}
                  className={iconBtn}
                >
                  <QrIcon size={16} />
                </button>
                <CopyButton text={configUrl(l.id)} label="Copy link" />
                <button
                  type="button"
                  title="Revoke link"
                  aria-label="Revoke link"
                  onClick={() => void revoke(l.id)}
                  className={`${iconBtn} hover:text-error`}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ImportBlock() {
  const [text, setText] = useState('')
  const [doc, setDoc] = useState<ConfigDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [seq, setSeq] = useState(0)
  // P2P files that came after the config text in a `.rchat` file.
  const [files, setFiles] = useState<FilesPart | null>(null)
  // Set only while the instance has P2P on for this account.
  const p2pOn = useP2p(s => s.account !== null)

  const preview = async (raw: string, file = false) => {
    setError(null)
    setDone(null)
    setDoc(null)
    setFiles(null)
    if (!file && raw.length > TEXT_MAX) {
      setError('Too long to paste. Use Import file instead')
      return
    }
    const id = file ? null : parseConfigLink(raw, shareOrigin())
    let input = raw
    if (id) {
      try {
        input = (await api.configShare(id)).blob
      } catch {
        setError('This link has expired or was revoked')
        return
      }
    }
    const decoded = await (id
      ? decodeLink(input)
      : decodeConfig(input, Date.now(), file ? FILE_LIMITS : undefined))
    if (!decoded.ok) setError(decoded.error)
    else {
      setDoc(decoded.doc)
      setSeq(n => n + 1)
    }
  }

  // Only the first line is read now; P2P files after it are streamed when they are imported.
  const openFile = async () => {
    setError(null)
    const file = await sharing().openBlob(`${FILE_EXT},.txt,text/plain,application/octet-stream`)
    if (file === null) return
    const split = await splitFile(file).catch(() => null)
    if (!split) return setError(`Choose a file under ${fmtSize(FILE_MAX)}`)
    const content = split.text.trim()
    const head = await filesHead(split.rest).catch(() => null)
    // Large files stay out of the text box; it would only slow the page down.
    setText(content.length > TEXT_MAX || head ? '' : content)
    await preview(content, true)
    setFiles(head ? { blob: split.rest, head } : null)
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        rows={3}
        value={text}
        placeholder="Paste a config string or link"
        aria-label="Config string to import"
        onChange={e => {
          setText(e.target.value)
          setDoc(null)
          setError(null)
        }}
        className={areaCls}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!text.trim()}
          onClick={() => void preview(text)}
          className={filledBtn}
        >
          Preview
        </button>
        <button type="button" onClick={() => void openFile()} className={textBtn}>
          Import file
        </button>
      </div>
      <FieldError message={error} />
      {done && (
        <p role="status" className="text-sm text-on-surface-variant">
          {done}
        </p>
      )}
      {doc?.p2p && p2pOn && <P2pImport key={`p2p-${seq}`} section={doc.p2p} files={files} />}
      {doc && (!doc.p2p || !p2pOn || presentSections(doc).length > 0) && (
        <ImportPreview
          key={seq}
          doc={doc}
          onDone={(applied, err) => {
            if (err) setError(err)
            if (applied) {
              setDoc(null)
              setText('')
              setDone('Config applied')
            }
          }}
        />
      )}
    </div>
  )
}

export function ConfigSyncSection() {
  const me = useStore(s => s.me !== null)
  const ask = useStore(s => accountPrompt(s.settings))
  const hasP2p = useP2p(s => s.ik !== null && s.movedAt === null) && me
  const [include, setInclude] = useState<Set<SectionKey>>(() => new Set(SECTIONS.map(s => s.key)))
  const [withP2p, setWithP2p] = useState(false)
  const [pass, setPass] = useState<PassState>({ pass: '', again: '', files: false })
  const doc = useExport(include)
  const p2pPass =
    !hasP2p || !withP2p ? false : passProblem(pass.pass, pass.again) ? null : pass.pass
  const toggle = (key: SectionKey) =>
    setInclude(cur => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className={sectionCls}>Sync config</p>
        <p className="mb-4 text-sm text-on-surface-variant">
          Move your settings and layout to another device or account. Passwords, sessions, drafts
          and files are never included.
        </p>
        <IncludeList include={include} onToggle={toggle} />
      </section>
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
      <section className="flex flex-col gap-3">
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
      </section>
      <section>
        <p className={sectionCls}>Import</p>
        <ImportBlock />
      </section>
    </div>
  )
}

type LinkState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; doc: ConfigDoc; expiresAt: number }

function LinkCard({ id }: { id: string }) {
  const router = useRouter()
  const authed = useStore(s => s.me !== null || s.guest)
  const closeConfigLink = useStore(s => s.closeConfigLink)
  const [state, setState] = useState<LinkState>({ kind: 'loading' })
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.configShare(id).then(
      async res => {
        const decoded = await decodeLink(res.blob)
        if (!live) return
        setState(
          decoded.ok
            ? { kind: 'ready', doc: decoded.doc, expiresAt: res.expires_at }
            : { kind: 'error', message: decoded.error }
        )
      },
      (e: unknown) => {
        if (!live) return
        const status = (e as { status?: number }).status
        setState(status === 404 ? { kind: 'missing' } : { kind: 'error', message: errorText(e) })
      }
    )
    return () => {
      live = false
    }
  }, [id])

  const logIn = () => router.push('/login/')

  return (
    <div className="w-full max-w-md rounded-3xl bg-surface-container p-6 shadow-elevation-2">
      <h1 className="text-xl font-medium text-on-surface">Shared config</h1>
      {state.kind === 'loading' && <p className="pt-3 text-sm text-on-surface-variant">Loading…</p>}
      {state.kind === 'missing' && (
        <p className="pt-3 text-sm text-on-surface-variant">
          This link has expired or was revoked.
        </p>
      )}
      {state.kind === 'error' && <FieldError message={state.message} />}
      {state.kind === 'ready' && (
        <>
          <p className="pt-1 pb-4 text-sm text-on-surface-variant">
            Pick what to apply on this device. Link active{' '}
            {untilText(state.expiresAt * 1000, Date.now())}.
          </p>
          {done ? (
            <p role="status" className="text-sm text-on-surface">
              {done}
            </p>
          ) : (
            <ImportPreview
              doc={state.doc}
              loggedOut={!authed}
              onDone={(applied, err) => {
                setError(err)
                if (!applied) return
                if (authed) {
                  useStore.getState().showToast('Config applied')
                  closeConfigLink()
                } else if (hasStashedConfig()) logIn()
                else setDone('Applied on this device')
              }}
            />
          )}
          <FieldError message={error} />
        </>
      )}
      <div className="flex flex-wrap gap-2 pt-5">
        {!authed && (
          <button type="button" onClick={logIn} className={textBtn}>
            Log in
          </button>
        )}
        {authed && (
          <button type="button" onClick={closeConfigLink} className={textBtn}>
            Close
          </button>
        )}
      </div>
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
