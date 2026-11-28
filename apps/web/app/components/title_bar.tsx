'use client'

import { useEffect, useState } from 'react'
import { desktopInfo, inShell, type DesktopOs } from '../lib/platform'
import { Inset } from './layout'
import { WindowButton } from './controls'

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
  const size = windows ? 10 : 8
  const maxLabel = maximized ? 'Restore' : 'Maximize'
  return (
    <Inset
      row
      pad={windows ? 'none' : 'sm'}
      inset="sides"
      gap={windows ? 'none' : 'md'}
      place="h-full shrink-0"
    >
      <WindowButton
        onClick={() => void win?.minimize()}
        kind={windows ? 'bar' : 'dot'}
        label="Minimize"
      >
        {glyph(MIN, size)}
      </WindowButton>
      <WindowButton
        onClick={() => void win?.toggleMaximize()}
        kind={windows ? 'bar' : 'dot'}
        label={maxLabel}
      >
        {glyph(maximized ? RESTORE : MAX, size)}
      </WindowButton>
      <WindowButton
        onClick={() => void win?.close()}
        kind={windows ? 'bar-close' : 'dot'}
        label="Close"
      >
        {glyph(CLOSE, size)}
      </WindowButton>
    </Inset>
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
      className="fixed inset-x-0 top-0 z-chrome flex h-titlebar items-center bg-surface-container-lowest text-xs text-on-surface-variant select-none"
    >
      {os === 'windows' ? (
        <Inset data-tauri-drag-region row pad="md" inset="sides" gap="sm" place="min-w-0 flex-1">
          <img src="/rchat_r.png" alt="" className="pointer-events-none size-4" />
          <span className="pointer-events-none truncate">{title}</span>
        </Inset>
      ) : (
        <div
          data-tauri-drag-region
          className={`flex min-w-0 flex-1 items-center justify-center ${mac ? 'titlebar-clear-mac' : 'titlebar-clear'}`}
        >
          <span className="pointer-events-none truncate font-medium">{title}</span>
        </div>
      )}
      {!mac && <Controls os={os} win={win} />}
    </div>
  )
}
