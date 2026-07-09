'use client'

import { useRef, useState } from 'react'
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
import { useStore } from '../lib/store'
import { Dialog, fieldCls, filledBtn } from './server_settings'

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

export function MessageComposer({ thread = false }: { thread?: boolean }) {
  const guest = useStore(s => s.guest)
  const view = useStore(s => s.view)
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const pending = useStore(s => (thread ? s.threadPending : s.pending))
  const assetUploads = useStore(s => s.settings.asset_uploads)
  const uploadFile = useStore(s => s.uploadFile)
  const toggleSpoiler = useStore(s => s.toggleSpoiler)
  const toggleUploadMode = useStore(s => s.toggleUploadMode)
  const sendMessage = useStore(s => s.sendMessage)
  const sendThreadMessage = useStore(s => s.sendThreadMessage)
  const [text, setText] = useState('')
  const [expiryOpen, setExpiryOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  if (!thread && !view) return null

  if (guest) {
    return (
      <div className="m-3 rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
        Viewing as a guest.{' '}
        <Link href="/login" className="text-primary underline">
          Create an account
        </Link>{' '}
        to send messages.
      </div>
    )
  }

  const target = thread
    ? 'thread'
    : view?.kind === 'channel'
      ? `#${servers[view.server]?.channels.find(c => c.id === view.channelId)?.name ?? ''}`
      : (dms.find(d => d.id === view?.dmId)?.other.display_name ?? '')

  const doSend = (p2pExpiresIn?: number | null) => {
    void (thread ? sendThreadMessage(text, p2pExpiresIn) : sendMessage(text, p2pExpiresIn))
    setText('')
  }

  const send = () => {
    if (!text.trim() && !pending) return
    if (pending?.mode === 'p2p') setExpiryOpen(true)
    else doSend()
  }

  return (
    <div className="shrink-0 px-3 pb-3">
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
          rows={1}
          value={text}
          onChange={e => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={`Message ${target}`}
          className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-on-surface-variant"
        />
        <button
          title="Send"
          onClick={send}
          className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}
