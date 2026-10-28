'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Clock,
  Eye,
  EyeOff,
  File as FileIcon,
  Lock,
  Plus,
  SendHorizontal,
  Server,
  Share2,
  Smile,
  X,
} from 'lucide-react'
import { errorText, useStore, viewKey } from '../lib/store'
import { MESSAGE_MAX, charCount } from '../lib/rules'
import { composing, sendKey } from '../lib/keys'
import { runJoinStep, type JoinStep } from '../lib/join_flow'
import { spliceText } from '../lib/autocomplete'
import { loadEmojiData } from '../lib/emoji'
import { parseSed } from '../lib/sed'
import { readOnly } from '../lib/reactions'
import { clock } from '../lib/slowmode'
import { Dialog, FieldError, fieldCls, filledBtn } from './server_settings'
import { EmojiPicker, SHEET_QUERY } from './emoji_picker'
import { useMedia } from './context_menu'
import { ReplyBar } from './replies'
import { ForwardBar } from './forwards'
import { useTextAssist } from './text_assist'

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

const NO_SEND = 'You do not have permission to send messages in this channel.'

const useSlowLeft = (channelId: number | null): number => {
  const until = useStore(s => (channelId === null ? 0 : (s.slowUntil[channelId] ?? 0)))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (until <= Date.now()) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= until) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [until])
  return Math.max(0, until - now)
}

function JoinBar({ server }: { server: string }) {
  const detail = useStore(s => s.servers[server])
  const joinServer = useStore(s => s.joinServer)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<JoinStep>('name')
  const locked = step === 'password'
  const ready = !busy && (!locked || password.trim() !== '')

  const join = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const out = await runJoinStep(step, password, pw => joinServer(server, pw), errorText)
    if (out.done) return
    setStep(out.step)
    setError(out.error)
    setBusy(false)
  }

  return (
    <div
      data-preview-bar
      className="mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0 rounded-2xl border border-dashed border-outline bg-surface-container px-4 py-3 keyboard:mb-3"
    >
      <form
        onSubmit={e => {
          e.preventDefault()
          void join()
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <p className="flex min-w-48 flex-1 items-center gap-2 text-sm text-on-surface-variant">
          <Eye size={16} className="shrink-0 text-primary" />
          <span className="min-w-0">
            You&apos;re previewing{' '}
            <span className="streamer font-medium text-on-surface">
              {detail?.display_name ?? server}
            </span>
          </span>
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
          Join server
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
  const draftKey = thread ? (rootId !== null ? `t${rootId}` : null) : view ? viewKey(view) : null
  const pending = useStore(s => (draftKey ? s.pending[draftKey] : undefined)) ?? null
  const assetUploads = useStore(s => s.settings.asset_uploads)
  const uploadFile = useStore(s => s.uploadFile)
  const toggleSpoiler = useStore(s => s.toggleSpoiler)
  const toggleUploadMode = useStore(s => s.toggleUploadMode)
  const sendMessage = useStore(s => s.sendMessage)
  const sendThreadMessage = useStore(s => s.sendThreadMessage)
  const setDraft = useStore(s => s.setDraft)
  const text = useStore(s => (draftKey ? (s.drafts[draftKey] ?? '') : ''))
  const replying = useStore(s => (draftKey ? s.replying[draftKey] !== undefined : false))
  const forwarding = useStore(s => s.forwardClip !== null)
  const threadChannel = useStore(s => (s.panel?.kind === 'thread' ? s.panel.root.channel_id : null))
  const cancelReply = useStore(s => s.cancelReply)
  const focusAsk = useStore(s => s.composerFocus)
  const editLast = useStore(s => s.editLast)
  const sedEdit = useStore(s => s.sedEdit)
  const [expiryOpen, setExpiryOpen] = useState(false)
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const sheet = useMedia(SHEET_QUERY)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const sel = useRef({ start: 0, end: 0 })
  const pickerOpen = pickerFor !== null && pickerFor === draftKey
  const focusSeen = useRef(focusAsk?.n ?? 0)
  const channelId = thread ? threadChannel : view?.kind === 'channel' ? view.channelId : null
  const slowLeft = useSlowLeft(channelId)

  useEffect(() => {
    if (!focusAsk || focusAsk.n === focusSeen.current) return
    focusSeen.current = focusAsk.n
    if (focusAsk.key === draftKey) inputRef.current?.focus()
  }, [focusAsk, draftKey])

  const draftNow = () => (draftKey ? (useStore.getState().drafts[draftKey] ?? '') : '')

  const assist = useTextAssist({
    listKey: draftKey,
    text,
    getText: draftNow,
    setText: value => {
      if (draftKey) setDraft(draftKey, value)
    },
    inputRef,
    paused: pickerOpen,
    maxHeight: 160,
  })
  const { trackCaret } = assist

  const openPicker = () => {
    const el = inputRef.current
    if (el) sel.current = { start: el.selectionStart, end: el.selectionEnd }
    setPickerFor(pickerOpen ? null : draftKey)
  }

  const insertEmoji = (picked: string) => {
    if (!draftKey) return
    const cur = draftNow()
    const start = Math.min(sel.current.start, cur.length)
    const end = Math.min(Math.max(sel.current.end, start), cur.length)
    const at = start + picked.length
    sel.current = { start: at, end: at }
    setDraft(draftKey, spliceText(cur, start, end, picked))
  }

  const closePicker = () => {
    setPickerFor(null)
    if (sheet) return
    requestAnimationFrame(() => {
      const el = inputRef.current
      const focused = document.activeElement
      if (!el || (focused && focused !== document.body)) return
      el.focus({ preventScroll: true })
      el.setSelectionRange(sel.current.start, sel.current.end)
      trackCaret(el)
    })
  }

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

  if (view?.kind === 'channel' && readOnly(servers[view.server], channelId)) {
    return (
      <div
        data-no-send
        className="mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] flex shrink-0 items-center gap-2 rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant keyboard:mb-3"
      >
        <Lock size={16} className="shrink-0" />
        <span>{NO_SEND}</span>
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

  const attach = (file: File | null) => {
    if (draftKey) uploadFile(draftKey, file)
  }

  const count = charCount(text)
  const tooLong = count > MESSAGE_MAX

  const closeBar = replying && draftKey ? () => cancelReply(draftKey) : null
  const bar =
    closeBar && draftKey ? (
      <ReplyBar draftKey={draftKey} onClose={closeBar} />
    ) : forwarding && draftKey ? (
      <ForwardBar draftKey={draftKey} />
    ) : null

  const doSend = (p2pExpiresIn?: number | null) => {
    void (thread ? sendThreadMessage(text, p2pExpiresIn) : sendMessage(text, p2pExpiresIn))
    setText('')
  }

  const send = () => {
    if ((!text.trim() && !pending) || tooLong) return
    const sed = pending || !draftKey ? null : parseSed(text)
    if (sed && draftKey) {
      const key = draftKey
      void sedEdit(key, sed).then(ok => {
        if (ok && draftNow() === text) setDraft(key, '')
      })
      return
    }
    if (slowLeft > 0) return
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
            onClick={() => attach(null)}
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
                onClick={() => draftKey && toggleUploadMode(draftKey)}
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
                onClick={() => draftKey && toggleSpoiler(draftKey)}
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
      {pickerOpen && (
        <EmojiPicker anchor={emojiRef.current} onPick={insertEmoji} onClose={closePicker} />
      )}
      {slowLeft > 0 && (
        <p
          role="status"
          className="mb-1 flex items-center justify-end gap-1 px-3 text-xs text-on-surface-variant tabular-nums"
        >
          <Clock size={12} className="shrink-0" />
          Slow mode: {clock(slowLeft)}
        </p>
      )}
      {bar}
      <div
        className={`relative flex items-end gap-2 bg-surface-container-high px-3 py-2 ${bar ? 'rounded-b-3xl' : 'rounded-3xl'}`}
      >
        {assist.popups}
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
                attach(e.target.files?.item(0) ?? null)
                e.target.value = ''
              }}
            />
          </>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          {...assist.textarea}
          onKeyDown={e => {
            if (assist.popupKey(e)) return
            if (
              e.key === 'ArrowUp' &&
              !text &&
              !e.shiftKey &&
              !e.altKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !composing(e) &&
              draftKey &&
              !(view?.kind === 'channel' && readOnly(servers[view.server], view.channelId)) &&
              editLast(draftKey)
            ) {
              e.preventDefault()
              return
            }
            if (e.key === 'Escape' && !e.nativeEvent.isComposing && closeBar) {
              e.preventDefault()
              closeBar()
              return
            }
            if (sendKey(e)) {
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
              attach(namePasted(file))
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
          ref={emojiRef}
          type="button"
          title="Emoji"
          aria-label="Emoji"
          aria-expanded={pickerOpen}
          onPointerEnter={() => void loadEmojiData().catch(() => {})}
          onClick={openPicker}
          className={`shrink-0 rounded-full p-1.5 ${
            pickerOpen
              ? 'bg-surface-container-highest text-primary'
              : 'text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
          }`}
        >
          <Smile size={20} />
        </button>
        <button
          title={
            tooLong
              ? 'Message is too long'
              : slowLeft > 0
                ? `Slow mode: ${clock(slowLeft)}`
                : 'Send'
          }
          aria-label="Send"
          onClick={send}
          disabled={tooLong || slowLeft > 0}
          className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90 disabled:opacity-40"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}
