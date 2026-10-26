'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Eye,
  EyeOff,
  File as FileIcon,
  Plus,
  SendHorizontal,
  Server,
  Share2,
  X,
} from 'lucide-react'
import { errorText, useStore, viewKey } from '../lib/store'
import { MESSAGE_MAX, charCount } from '../lib/rules'
import { Dialog, FieldError, fieldCls, filledBtn } from './server_settings'

const PRESETS: { label: string; seconds: number | null }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: 'Indefinite', seconds: null },
]

const UNITS = [
  { label: 'seconds', mult: 1 },
  { label: 'minutes', mult: 60 },
  { label: 'hours', mult: 3600 },
  { label: 'days', mult: 86400 },
]

const IMG_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }
const namePasted = (f: File) =>
  new File([f], `pasted.${IMG_EXT[f.type] ?? f.type.split('/')[1] ?? 'png'}`, { type: f.type })

function ExpiryDialog({
  onPick,
  onClose,
}: {
  onPick: (seconds: number | null) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState('')
  const [mult, setMult] = useState(3600)
  const custom = Number(amount)
  const customOk = Number.isFinite(custom) && custom > 0
  return (
    <Dialog title="P2P file expiration" onClose={onClose}>
      <p className="text-sm text-on-surface-variant">
        Choose how long the P2P files in this message stay stored in your browser. Others can only
        download them while you are online.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map(p => (
          <button
            key={p.label}
            onClick={() => onPick(p.seconds)}
            className="rounded-full border border-outline px-3 py-1.5 text-sm hover:bg-surface-container-highest"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <input
          type="number"
          min={1}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="Custom"
          className={`${fieldCls} w-24 flex-1`}
        />
        <select value={mult} onChange={e => setMult(Number(e.target.value))} className={fieldCls}>
          {UNITS.map(u => (
            <option key={u.mult} value={u.mult}>
              {u.label}
            </option>
          ))}
        </select>
        <button
          disabled={!customOk}
          onClick={() => onPick(Math.round(custom * mult))}
          className={`${filledBtn} disabled:opacity-40`}
        >
          Send
        </button>
      </div>
    </Dialog>
  )
}

function JoinBar({ server }: { server: string }) {
  const detail = useStore(s => s.servers[server])
  const joinServer = useStore(s => s.joinServer)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const locked = detail?.has_password ?? false
  const ready = !busy && (!locked || password.trim() !== '')

  const join = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await joinServer(server, locked ? password.trim() : undefined)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div className="mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0 rounded-2xl bg-surface-container px-4 py-3 keyboard:mb-3">
      <form
        onSubmit={e => {
          e.preventDefault()
          void join()
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <p className="min-w-48 flex-1 text-sm text-on-surface-variant">
          You are viewing{' '}
          <span className="streamer font-medium text-on-surface">
            {detail?.display_name ?? server}
          </span>
          . Join this server to send messages.
        </p>
        {locked && (
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Server password"
            className={`${fieldCls} max-w-56`}
          />
        )}
        <button disabled={!ready} className={filledBtn}>
          Join this server
        </button>
      </form>
      <FieldError message={error} />
    </div>
  )
}

export function MessageComposer({ thread = false }: { thread?: boolean }) {
  const guest = useStore(s => s.guest)
  const logout = useStore(s => s.logout)
  const view = useStore(s => s.view)
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const streamer = useStore(s => s.streamer)
  const rootId = useStore(s => (s.panel?.kind === 'thread' ? s.panel.root.id : null))
  const member = useStore(s => {
    const v = s.view
    return !s.me || v?.kind !== 'channel' || s.me.servers.some(x => x.name === v.server)
  })
  const pending = useStore(s => (thread ? s.threadPending : s.pending))
  const assetUploads = useStore(s => s.settings.asset_uploads)
  const uploadFile = useStore(s => s.uploadFile)
  const toggleSpoiler = useStore(s => s.toggleSpoiler)
  const toggleUploadMode = useStore(s => s.toggleUploadMode)
  const sendMessage = useStore(s => s.sendMessage)
  const sendThreadMessage = useStore(s => s.sendThreadMessage)
  const setDraft = useStore(s => s.setDraft)
  const draftKey = thread ? (rootId !== null ? `t${rootId}` : null) : view ? viewKey(view) : null
  const text = useStore(s => (draftKey ? (s.drafts[draftKey] ?? '') : ''))
  const [expiryOpen, setExpiryOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text, draftKey])

  if (!thread && !view) return null

  if (!guest && !member && view?.kind === 'channel') return <JoinBar server={view.server} />

  if (guest) {
    return (
      <div className="m-3 rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
        Viewing as a guest.{' '}
        <Link href="/login" onClick={() => logout()} className="text-primary underline">
          Create an account
        </Link>{' '}
        to send messages.
      </div>
    )
  }

  const placeholder = thread
    ? 'Message thread'
    : view?.kind === 'channel'
      ? `Message #${servers[view.server]?.channels.find(c => c.id === view.channelId)?.name ?? ''}`
      : streamer
        ? 'Send a direct message'
        : `Message ${dms.find(d => d.id === view?.dmId)?.other.display_name ?? ''}`

  const setText = (value: string) => {
    if (draftKey) setDraft(draftKey, value)
  }

  const count = charCount(text)
  const tooLong = count > MESSAGE_MAX

  const doSend = (p2pExpiresIn?: number | null) => {
    void (thread ? sendThreadMessage(text, p2pExpiresIn) : sendMessage(text, p2pExpiresIn))
    setText('')
  }

  const send = () => {
    if ((!text.trim() && !pending) || tooLong) return
    if (pending?.mode === 'p2p') setExpiryOpen(true)
    else doSend()
  }

  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] keyboard:pb-3">
      {expiryOpen && (
        <ExpiryDialog
          onPick={seconds => {
            setExpiryOpen(false)
            doSend(seconds)
          }}
          onClose={() => setExpiryOpen(false)}
        />
      )}
      {pending && (
        <div className="relative mb-2 flex h-24 w-48 flex-col justify-between rounded-xl border border-outline-variant bg-surface-container p-3">
          <button
            title="Remove file"
            onClick={() => uploadFile(null, thread)}
            className="absolute -top-2 -right-2 rounded-full bg-error-container p-1 text-on-error-container shadow-elevation-1"
          >
            <X size={12} />
          </button>
          <div className="flex items-center justify-between">
            <FileIcon size={20} className="text-primary" />
            <div className="flex items-center gap-1">
              <button
                title={
                  pending.mode === 'p2p'
                    ? 'P2P: hosted from your browser while you are online. Click for server upload'
                    : 'Server: uploaded to the server, removed after 1 day. Click for P2P'
                }
                onClick={() => toggleUploadMode(thread)}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                  pending.mode === 'p2p'
                    ? 'bg-tertiary-container text-on-tertiary-container'
                    : 'bg-surface-container-highest text-on-surface-variant'
                }`}
              >
                {pending.mode === 'p2p' ? <Share2 size={12} /> : <Server size={12} />}
                {pending.mode === 'p2p' ? 'P2P' : 'Server'}
              </button>
              <button
                title={pending.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
                onClick={() => toggleSpoiler(thread)}
                className={`rounded-full p-1 ${
                  pending.spoiler
                    ? 'bg-primary-container text-on-primary-container'
                    : 'text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                {pending.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
          <span className="truncate text-xs">
            {pending.spoiler ? 'Spoiler · ' : ''}
            {pending.file.name}
          </span>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-3xl bg-surface-container-high px-3 py-2">
        {assetUploads && (
          <>
            <button
              title="Attach a file"
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
            >
              <Plus size={20} />
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={e => {
                uploadFile(e.target.files?.item(0) ?? null, thread)
                e.target.value = ''
              }}
            />
          </>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          onPaste={e => {
            if (!assetUploads) return
            const file = Array.from(e.clipboardData.items)
              .find(i => i.kind === 'file' && i.type.startsWith('image/'))
              ?.getAsFile()
            if (file) {
              e.preventDefault()
              uploadFile(namePasted(file), thread)
            }
          }}
          placeholder={placeholder}
          className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-on-surface-variant md:text-sm"
        />
        {count > MESSAGE_MAX - 500 && (
          <span
            title={`Messages can be up to ${MESSAGE_MAX} characters`}
            className={`shrink-0 self-center text-xs tabular-nums ${tooLong ? 'font-medium text-error' : 'text-on-surface-variant'}`}
          >
            {MESSAGE_MAX - count}
          </span>
        )}
        <button
          title={tooLong ? 'Message is too long' : 'Send'}
          onClick={send}
          disabled={tooLong}
          className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90 disabled:opacity-40"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}
