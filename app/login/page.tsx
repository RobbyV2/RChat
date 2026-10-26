'use client'

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Globe } from 'lucide-react'
import { DEFAULT_INSTANCE_NAME, api, home, knownInstances, normalizeOrigin } from '../lib/instances'
import { hostOf } from '../lib/qualified'
import { useStore } from '../lib/store'
import { safeNext } from '../lib/invite'
import { NAME_MAX, charCount } from '../lib/rules'
import type { AvatarKind } from '../lib/types'
import type { PassKind } from '../lib/password'
import { AvatarPicker } from '../components/avatar_picker'
import { PassSwitch, WordGrid } from '../components/word_grid'
import StatusClock, { ThemeToggle } from '../components/status_clock'
import { InstallButton, IosInstallHint } from '../components/pwa_register'

type Mode = 'login' | 'register'

const inputCls =
  'rounded-lg border border-outline bg-transparent px-3 py-2 outline-none focus:border-primary'

const signedIn = () =>
  localStorage.getItem(home.scoped('rchat_token')) !== null ||
  localStorage.getItem(home.scoped('rchat_guest')) !== null

function blurHosts(text: string, hosts: (string | null)[]): ReactNode {
  const wanted = [...new Set(hosts.filter((h): h is string => !!h))].sort(
    (a, b) => b.length - a.length
  )
  if (wanted.length === 0) return text
  const escaped = wanted.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return text.split(new RegExp(`(${escaped.join('|')})`)).map((part, at) =>
    at % 2 === 1 ? (
      <span key={at} className="streamer">
        {part}
      </span>
    ) : (
      part
    )
  )
}

function InstancePicker({
  onSwitched,
  onMissing,
}: {
  onSwitched: () => void
  onMissing: (missing: boolean) => void
}) {
  const info = useStore(s => s.instance)
  const host = useStore(s => s.instanceHost)
  const loadInstance = useStore(s => s.loadInstance)
  const switchInstance = useStore(s => s.switchInstance)
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [error, setError] = useState<ReactNode>(null)
  const [busy, setBusy] = useState(false)
  const [known, setKnown] = useState<{ origin: string; name: string }[]>([])
  const listId = useId()

  useEffect(() => {
    let live = true
    void loadInstance().then(found => {
      if (!live) return
      onMissing(!found)
      if (found) {
        void useStore.getState().loadSettings()
        return
      }
      setOpen(true)
      setError(
        <>
          No RChat instance answered at <span className="streamer">{home.host}</span>. Enter the
          instance to use.
        </>
      )
    })
    setKnown(knownInstances().map(({ origin, info }) => ({ origin, name: info.name })))
    return () => {
      live = false
    }
  }, [loadInstance, onMissing])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const failed = await switchInstance(address || home.origin)
    setBusy(false)
    if (failed) {
      const typed = normalizeOrigin(address)
      setError(blurHosts(failed, [home.host, typed ? hostOf(typed) : null, address.trim()]))
      return
    }
    setOpen(false)
    setAddress('')
    onMissing(false)
    if (signedIn()) onSwitched()
  }

  const name = info?.name || DEFAULT_INSTANCE_NAME
  if (!open)
    return (
      <div className="flex min-w-0 items-center gap-3 rounded-xl bg-surface-container px-3 py-2">
        <Globe size={18} className="shrink-0 text-on-surface-variant" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-on-surface-variant">Instance</p>
          <p className="truncate text-sm" title={host ? `${name} (${host})` : name}>
            <span className="streamer font-medium text-on-surface">{name}</span>
            {host && <span className="streamer ml-1.5 text-on-surface-variant">{host}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            setError(null)
          }}
          className="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-high"
        >
          Change
        </button>
      </div>
    )
  return (
    <form onSubmit={submit} className="flex flex-col gap-1 rounded-xl bg-surface-container p-3">
      <label htmlFor={`${listId}-input`} className="text-sm text-on-surface-variant">
        Instance
      </label>
      <div className="flex min-w-0 gap-2">
        <input
          id={`${listId}-input`}
          value={address}
          onChange={e => setAddress(e.target.value)}
          list={listId}
          placeholder={home.origin}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error !== null}
          className={`${inputCls} min-w-0 flex-1`}
        />
        <button
          disabled={busy}
          className="shrink-0 rounded-full bg-secondary-container px-4 text-sm font-medium text-on-secondary-container hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
      <datalist id={listId}>
        {known.map(k => (
          <option key={k.origin} value={k.origin}>
            {k.name}
          </option>
        ))}
      </datalist>
      {error ? (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      ) : (
        <p className="text-xs text-on-surface-variant">
          The RChat server your account lives on, for example chat.example.com.
        </p>
      )}
      {info !== null && (
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
          className="self-end rounded-full px-3 py-1 text-sm text-on-surface-variant hover:bg-surface-container-high"
        >
          Cancel
        </button>
      )}
    </form>
  )
}

export default function LoginPage() {
  const router = useRouter()
  const authed = useStore(s => !!s.token || s.guest)
  const error = useStore(s => s.error)
  const setError = useStore(s => s.setError)
  const login = useStore(s => s.login)
  const register = useStore(s => s.register)
  const enterGuest = useStore(s => s.enterGuest)
  const guestsEnabled = useStore(s => s.settings.guests_enabled)
  const [missing, setMissing] = useState(false)

  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [passKind, setPassKind] = useState<PassKind>('text')
  const [password, setPassword] = useState('')
  const [words, setWords] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [avatarKind, setAvatarKind] = useState<AvatarKind>('identicon')
  const [avatarColor, setAvatarColor] = useState('#6750a4')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!authed) return
    router.replace(safeNext(new URLSearchParams(window.location.search).get('next')) ?? '/')
  }, [authed, router])

  useEffect(() => {
    if (passKind !== 'words') return
    const name = username.trim()
    if (!name) {
      setWords([])
      setSelected([])
      return
    }
    const timer = setTimeout(() => {
      api
        .words(name)
        .then(res => {
          setWords(res.words)
          setSelected(sel => sel.filter(w => res.words.includes(w)))
        })
        .catch(e => setError(e instanceof Error ? e.message : String(e)))
    }, 300)
    return () => clearTimeout(timer)
  }, [username, passKind, setError])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (missing) {
      setError('Connect to an RChat instance first')
      return
    }
    const name = username.trim()
    if (!name) {
      setError('Enter a username')
      return
    }
    if (mode === 'register' && charCount(name) > NAME_MAX) {
      setError(`Usernames can be at most ${NAME_MAX} characters`)
      return
    }
    if (mode === 'register' && name.includes('@')) {
      setError("Usernames can't contain @")
      return
    }
    if (passKind === 'words' && selected.length !== 7) {
      setError('Pick 7 words in order')
      return
    }
    if (mode === 'register' && passKind === 'text' && !password) {
      setError('Enter a password')
      return
    }
    setBusy(true)
    const cred = passKind === 'text' ? { password } : { words: selected }
    if (mode === 'login') {
      await login({ username: name, ...cred })
    } else {
      await register({
        username: name,
        ...cred,
        avatar_kind: avatarKind,
        ...(avatarKind === 'color' ? { avatar_color: avatarColor } : {}),
      })
    }
    setBusy(false)
  }

  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      onClick={() => {
        setMode(value)
        setError(null)
      }}
      className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
        mode === value
          ? 'bg-primary-container text-on-primary-container'
          : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex min-h-dvh flex-col items-center px-safe-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-safe-4">
      <header className="flex w-full shrink-0 items-center justify-between pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <ThemeToggle />
        <StatusClock />
      </header>
      <div className="my-auto flex w-full max-w-md flex-col gap-5 rounded-2xl bg-surface-container-low p-4 shadow-elevation-2 sm:p-6">
        <h1 className="flex justify-center">
          <img src="/rchat_logo.png" alt="RChat" className="h-16 w-auto" />
        </h1>
        <InstancePicker
          onMissing={setMissing}
          onSwitched={() =>
            router.replace(safeNext(new URLSearchParams(window.location.search).get('next')) ?? '/')
          }
        />
        <div className="flex gap-1 rounded-full bg-surface-container p-1">
          {tab('login', 'Log in')}
          {tab('register', 'Create account')}
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-on-surface-variant">Username</span>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              className={inputCls}
            />
          </label>
          <PassSwitch value={passKind} onChange={setPassKind} />
          {passKind === 'text' ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-on-surface-variant">Password</span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className={inputCls}
              />
            </label>
          ) : words.length ? (
            <WordGrid words={words} selected={selected} onChange={setSelected} />
          ) : (
            <p className="text-sm text-on-surface-variant">
              Type a username to see its 20 words, then pick 7 in order.
            </p>
          )}
          {mode === 'register' && (
            <AvatarPicker
              username={username}
              kind={avatarKind}
              color={avatarColor}
              onKind={setAvatarKind}
              onColor={setAvatarColor}
            />
          )}
          {error && (
            <p className="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-primary py-2.5 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
        {guestsEnabled && !missing && (
          <button
            type="button"
            onClick={() => void enterGuest()}
            className="flex flex-wrap items-center justify-center gap-x-1 rounded-full px-3 py-2 text-sm text-primary hover:bg-surface-container-high"
          >
            Skip to RChat <ArrowRight size={16} /> (cannot send messages)
          </button>
        )}
        <div className="flex flex-col items-center gap-1">
          <InstallButton />
          <IosInstallHint />
        </div>
      </div>
    </div>
  )
}
