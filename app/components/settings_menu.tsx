'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../lib/store'
import type { AvatarKind } from '../lib/types'
import { AvatarPicker } from './avatar_picker'
import { SettingSwitch } from './admin_panel'
import { filledBtn, sectionCls } from './server_settings'

type Section = 'account' | 'appearance' | 'streamer'

export default function SettingsMenu() {
  const open = useStore(s => s.activeDialog?.kind === 'settings')
  return open ? <Menu /> : null
}

function AccountSection() {
  const me = useStore(s => s.me)
  const patchMe = useStore(s => s.patchMe)
  const [kind, setKind] = useState<AvatarKind>(me?.avatar_kind ?? 'identicon')
  const [color, setColor] = useState(me?.avatar_color ?? '#6750a4')
  if (!me) return null
  return (
    <>
      <p className={sectionCls}>Account</p>
      <p className="mb-4 text-sm text-on-surface-variant">
        Signed in as <span className="streamer font-medium text-on-surface">{me.display_name}</span>
      </p>
      <AvatarPicker
        username={me.username}
        kind={kind}
        color={color}
        onKind={setKind}
        onColor={setColor}
      />
      <button
        onClick={() => void patchMe(kind, kind === 'color' ? color : undefined)}
        className={`mt-4 ${filledBtn}`}
      >
        Save avatar
      </button>
    </>
  )
}

function Menu() {
  const me = useStore(s => s.me)
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const streamer = useStore(s => s.streamer)
  const setStreamer = useStore(s => s.setStreamer)
  const closeDialog = useStore(s => s.closeDialog)
  const [section, setSection] = useState<Section>(me ? 'account' : 'appearance')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDialog])

  const sections: [Section, string][] = [
    ...(me ? ([['account', 'Account']] as [Section, string][]) : []),
    ['appearance', 'Appearance'],
    ['streamer', 'Streamer mode'],
  ]

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface md:flex-row">
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container-low p-3 md:w-56 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:p-4">
        <p className="hidden px-3 pb-2 text-xs font-medium tracking-wide text-on-surface-variant uppercase md:block">
          Settings
        </p>
        {sections.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-left text-sm md:rounded-xl md:py-2 ${
              section === key
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="relative flex-1 overflow-y-auto p-6 md:p-10">
        <button
          title="Close settings"
          onClick={closeDialog}
          className="absolute top-4 right-4 rounded-full border border-outline-variant p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        >
          <X size={18} />
        </button>
        <div className="max-w-lg">
          {section === 'account' && <AccountSection />}
          {section === 'appearance' && (
            <>
              <p className={sectionCls}>Appearance</p>
              <SettingSwitch
                label="Light theme"
                value={theme === 'light'}
                onChange={v => setTheme(v ? 'light' : 'dark')}
              />
            </>
          )}
          {section === 'streamer' && (
            <>
              <p className={sectionCls}>Streamer mode</p>
              <SettingSwitch label="Streamer mode" value={streamer} onChange={setStreamer} />
              <p className="mt-2 px-2 text-xs text-on-surface-variant">
                Blurs server names, usernames, and DM names until hovered.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
