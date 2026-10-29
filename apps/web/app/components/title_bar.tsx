'use client'

import { useEffect, useState } from 'react'
import { desktopInfo, inShell, type DesktopOs } from '../lib/platform'

type Win = Awaited<ReturnType<typeof loadWindow>>

const loadWindow = async () => (await import('@tauri-apps/api/window')).getCurrentWindow()

// Thin line glyphs drawn like the system ones: Segoe Fluent on Windows, Adwaita on Linux.
const glyph = (d: string, size: number) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth={size > 9 ? 1 : 1.4}
    aria-hidden
    className="pointer-events-none"
  >
    <path d={d} />
  </svg>
)

const MIN = 'M0 5.5h10'
const MAX = 'M.5.5h9v9h-9z'
const RESTORE = 'M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z'
const CLOSE = 'M.5.5l9 9M9.5.5l-9 9'

function useMaximized(win: Win | null) {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!win) return
    let live = true
    const sync = () =>
      void win.isMaximized().then(
        m => live && setMaximized(m),
        () => {}
      )
    sync()
    const off = win.onResized(sync).catch(() => () => {})
    return () => {
      live = false
      void off.then(f => f())
    }
  }, [win])
  return maximized
}

function Controls({ os, win }: { os: DesktopOs; win: Win | null }) {
  const maximized = useMaximized(win)
  const windows = os === 'windows'
  const focus = 'outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-primary'
  const btn = windows
    ? `${focus} flex h-full w-[46px] items-center justify-center text-on-surface hover:bg-on-surface/10 active:bg-on-surface/20`
    : `${focus} flex size-6 items-center justify-center rounded-full bg-on-surface/10 text-on-surface hover:bg-on-surface/20 active:bg-on-surface/30`
  const close = windows
    ? `${focus} flex h-full w-[46px] items-center justify-center text-on-surface hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/80 active:text-white`
    : btn
  const size = windows ? 10 : 8
  const maxLabel = maximized ? 'Restore' : 'Maximize'
  return (
    <div className={`flex h-full shrink-0 items-center ${windows ? '' : 'gap-3 px-2.5'}`}>
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void win?.minimize()}
        className={btn}
      >
        {glyph(MIN, size)}
      </button>
      <button
        type="button"
        title={maxLabel}
        aria-label={maxLabel}
        onClick={() => void win?.toggleMaximize()}
        className={btn}
      >
        {glyph(maximized ? RESTORE : MAX, size)}
      </button>
      <button
        type="button"
        title="Close"
        aria-label="Close"
        onClick={() => void win?.close()}
        className={close}
      >
        {glyph(CLOSE, size)}
      </button>
    </div>
  )
}

function useTitle() {
  const [title, setTitle] = useState('')
  useEffect(() => {
    const sync = () => setTitle(document.title)
    sync()
    const head = document.querySelector('head')
    if (!head) return
    const watch = new MutationObserver(sync)
    watch.observe(head, { subtree: true, childList: true, characterData: true })
    return () => watch.disconnect()
  }, [])
  return title
}

// The window's title bar in the desktop shell. Windows and Linux windows have no frame, so this
// draws the drag area and the window buttons in each system's place and style; macOS keeps its
// own traffic lights over the left end. Double-clicking the drag area maximizes.
export default function TitleBar() {
  const [os, setOs] = useState<DesktopOs | null>(null)
  const [win, setWin] = useState<Win | null>(null)
  const title = useTitle()
  useEffect(() => {
    const info = desktopInfo()
    setOs(info?.os ?? null)
    if (info && inShell()) void loadWindow().then(setWin, () => {})
  }, [])
  if (!os) return null
  const mac = os === 'macos'
  return (
    <div
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-80 flex h-(--titlebar-h) items-center bg-surface-container-lowest text-xs text-on-surface-variant select-none"
    >
      {os === 'windows' ? (
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 pl-3">
          <img src="/rchat_r.png" alt="" className="pointer-events-none size-4" />
          <span className="pointer-events-none truncate">{title}</span>
        </div>
      ) : (
        <div
          data-tauri-drag-region
          className={`flex min-w-0 flex-1 items-center justify-center ${mac ? 'px-20' : 'pl-28'}`}
        >
          <span className="pointer-events-none truncate font-medium">{title}</span>
        </div>
      )}
      {!mac && <Controls os={os} win={win} />}
    </div>
  )
}
