// The Tauri desktop shell. It defines `window.__RCHAT_DESKTOP__` before the page loads; the web
// build never has it. Calls go through `invoke` so tests can pass a fake.

export type DesktopOs = 'windows' | 'macos' | 'linux'

export interface DesktopInfo {
  os: DesktopOs
  version: string
}

const OSES: readonly string[] = ['windows', 'macos', 'linux']

export const desktopInfo = (
  w: unknown = typeof window === 'undefined' ? undefined : window
): DesktopInfo | null => {
  const raw = (w as { __RCHAT_DESKTOP__?: unknown } | undefined)?.__RCHAT_DESKTOP__
  if (typeof raw !== 'object' || raw === null) return null
  const { os, version } = raw as Record<string, unknown>
  return typeof os === 'string' && OSES.includes(os) && typeof version === 'string'
    ? { os: os as DesktopOs, version }
    : null
}

// True only inside the real shell, where native calls work.
export const inShell = (w: unknown = typeof window === 'undefined' ? undefined : window) =>
  desktopInfo(w) !== null && typeof w === 'object' && w !== null && '__TAURI_INTERNALS__' in w

export type InvokeArgs = Record<string, unknown> | Uint8Array
export type Invoke = <T>(
  cmd: string,
  args?: InvokeArgs,
  options?: { headers: Record<string, string> }
) => Promise<T>

// Loaded on first use, so the web build never downloads it.
export const invoke: Invoke = async (cmd, args, options) => {
  const core = await import('@tauri-apps/api/core')
  return core.invoke(cmd, args, options)
}

export const listen = async (event: string, cb: () => void) => {
  const events = await import('@tauri-apps/api/event')
  return events.listen(event, () => cb())
}

export type Channel = 'stable' | 'weekly'

export interface ShellSettings {
  close_to_tray: boolean
  auto_update: boolean
  channel: Channel
}

export interface FoundUpdate {
  version: string
  notes: string | null
}

export interface Shell {
  settings: () => Promise<ShellSettings>
  setSettings: (next: ShellSettings) => Promise<void>
  autostart: () => Promise<boolean>
  setAutostart: (on: boolean) => Promise<void>
  checkUpdate: () => Promise<FoundUpdate | null>
  installUpdate: () => Promise<void>
  takeLinks: () => Promise<string[]>
  openExternal: (url: string) => Promise<void>
}

export const shellOf = (call: Invoke): Shell => ({
  settings: () => call('desktop_settings'),
  setSettings: settings => call('set_desktop_settings', { settings }),
  autostart: () => call('autostart'),
  setAutostart: on => call('set_autostart', { on }),
  checkUpdate: () => call('update_check'),
  installUpdate: () => call('update_install'),
  takeLinks: () => call('take_deep_links'),
  openExternal: url => call('open_external', { url }),
})

export const shell = shellOf(invoke)

// Errors from the shell are plain strings.
export const shellError = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : 'Something went wrong'
