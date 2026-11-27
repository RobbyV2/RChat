'use client'

import { useEffect, useState } from 'react'
import { desktopInfo, inShell } from '../lib/platform'
import { shell, shellError, type FoundUpdate, type ShellSettings } from '../lib/platform/desktop'
import { SettingNotes, SettingSwitch } from './settings_fields'
import { Button } from './controls'
import { Row } from './layout'
import { sectionCls } from './ui'

type Check =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'found'; update: FoundUpdate }
  | { kind: 'done'; text: string }

const note = 'text-xs text-on-surface-variant'

function Updates({
  settings,
  save,
}: {
  settings: ShellSettings
  save: (s: ShellSettings) => void
}) {
  const [check, setCheck] = useState<Check>({ kind: 'idle' })
  const run = async () => {
    setCheck({ kind: 'busy', text: 'Checking…' })
    try {
      const update = await shell.checkUpdate()
      setCheck(
        update ? { kind: 'found', update } : { kind: 'done', text: 'You have the latest version.' }
      )
    } catch (e) {
      setCheck({ kind: 'done', text: shellError(e) })
    }
  }
  const install = async () => {
    setCheck({ kind: 'busy', text: 'Downloading the update…' })
    try {
      await shell.installUpdate()
    } catch (e) {
      setCheck({ kind: 'done', text: shellError(e) })
    }
  }
  return (
    <section>
      <p className={sectionCls}>Updates</p>
      <SettingSwitch
        label="Check for updates on start"
        value={settings.auto_update}
        onChange={v => save({ ...settings, auto_update: v })}
      />
      <SettingSwitch
        label="Weekly builds"
        value={settings.channel === 'weekly'}
        onChange={v => save({ ...settings, channel: v ? 'weekly' : 'stable' })}
      />
      <SettingNotes gap="md">
        <p className={note}>
          Updates come from GitHub Releases. Weekly builds have the newest changes and may be less
          stable.
        </p>
        <Row gap="md" wrap>
          {check.kind === 'found' ? (
            <Button variant="filled" size="md" onClick={() => void install()}>
              Install {check.update.version} and restart
            </Button>
          ) : (
            <Button disabled={check.kind === 'busy'} onClick={() => void run()}>
              Check for updates
            </Button>
          )}
          <span role="status" className="text-xs text-on-surface-variant">
            {check.kind === 'busy' || check.kind === 'done' ? check.text : null}
          </span>
        </Row>
      </SettingNotes>
    </section>
  )
}

// Desktop shell options. Only shown inside the shell; the settings live in the shell, not the page.
export function DesktopSection() {
  const [settings, setSettings] = useState<ShellSettings | null>(null)
  const [autostart, setAutostart] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!desktopInfo() || !inShell()) return
    void shell.settings().then(setSettings, e => setError(shellError(e)))
    void shell.autostart().then(setAutostart, () => {})
  }, [])
  if (!settings) return null
  const save = (next: ShellSettings) => {
    setSettings(next)
    setError(null)
    shell.setSettings(next).catch(e => setError(shellError(e)))
  }
  const toggleStart = (on: boolean) => {
    setAutostart(on)
    shell.setAutostart(on).catch(e => {
      setAutostart(!on)
      setError(shellError(e))
    })
  }
  return (
    <>
      <section>
        <p className={sectionCls}>Desktop app</p>
        <SettingSwitch
          label="Close to tray"
          value={settings.minimize_to_tray}
          onChange={v => save({ ...settings, minimize_to_tray: v })}
        />
        <SettingNotes>
          <p className={note}>Closing the window keeps the app running in the tray.</p>
        </SettingNotes>
        <SettingSwitch label="Start on login" value={autostart} onChange={toggleStart} />
        <SettingNotes>
          <p className={note}>Starts in the tray when you sign in to your computer.</p>
          {error && (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          )}
          <p className={note}>Version {desktopInfo()?.version}</p>
        </SettingNotes>
      </section>
      <Updates settings={settings} save={save} />
    </>
  )
}
