'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, KeyRound, LayoutGrid } from 'lucide-react'
import * as api from '../lib/api'
import { useStore } from '../lib/store'
import type { AvatarKind } from '../lib/types'
import { AvatarPicker } from '../components/avatar_picker'
import { WordGrid } from '../components/word_grid'
import StatusClock, { ThemeToggle } from '../components/status_clock'
import { InstallButton, IosInstallHint } from '../components/pwa_register'

type Mode = 'login' | 'register'
type PassKind = 'text' | 'words'

export default function LoginPage() {
  const router = useRouter()
  const authed = useStore(s => !!s.token || s.guest)
  const error = useStore(s => s.error)
  const setError = useStore(s => s.setError)
  const login = useStore(s => s.login)
  const register = useStore(s => s.register)
  const enterGuest = useStore(s => s.enterGuest)
  const guestsEnabled = useStore(s => s.settings.guests_enabled)
  const loadSettings = useStore(s => s.loadSettings)

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

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
    if (authed) router.replace('/')
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
    const name = username.trim()
    if (!name) {
      setError('Enter a username')
      return
    }
    if (passKind === 'words' && selected.length !== 7) {
      setError('Pick 7 words in order')
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
      onClick={() => setMode(value)}
      className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
        mode === value
          ? 'bg-primary-container text-on-primary-container'
          : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {label}
    </button>
  )

  const passTab = (value: PassKind, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setPassKind(value)}
      className={`flex flex-1 items-center justify-center gap-2 border border-outline py-2 text-sm transition-colors first:rounded-l-full last:rounded-r-full ${
        passKind === value
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {icon}
      {label}
    </button>
  )

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="fixed right-4 top-4">
        <StatusClock />
      </div>
      <div className="fixed bottom-4 left-4">
        <ThemeToggle />
      </div>
      <div className="flex w-full max-w-md flex-col gap-5 rounded-2xl bg-surface-container-low p-6 shadow-elevation-2">
        <h1 className="flex justify-center">
          <img src="/rchat_logo.png" alt="RChat" className="h-16 w-auto" />
        </h1>
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
              className="rounded-lg border border-outline bg-transparent px-3 py-2 outline-none focus:border-primary"
            />
          </label>
          <div className="flex">
            {passTab('text', 'Password', <KeyRound size={16} />)}
            {passTab('words', 'Word grid', <LayoutGrid size={16} />)}
          </div>
          {passKind === 'text' ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-on-surface-variant">Password</span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="rounded-lg border border-outline bg-transparent px-3 py-2 outline-none focus:border-primary"
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
        {guestsEnabled && (
          <button
            type="button"
            onClick={() => void enterGuest()}
            className="flex items-center justify-center gap-1 rounded-full py-2 text-sm text-primary hover:bg-surface-container-high"
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
