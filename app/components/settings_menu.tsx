'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../lib/store'
import type { AvatarKind } from '../lib/types'
import { AvatarPicker } from './avatar_picker'
import { SettingSwitch } from './admin_panel'
import { filledBtn, sectionCls } from './server_settings'

type Section = 'settings' | 'information'

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
    <section>
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
    </section>
  )
}

function SettingsSection() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const streamer = useStore(s => s.streamer)
  const setStreamer = useStore(s => s.setStreamer)
  return (
    <div className="flex flex-col gap-8">
      <AccountSection />
      <section>
        <p className={sectionCls}>Appearance</p>
        <SettingSwitch
          label="Light theme"
          value={theme === 'light'}
          onChange={v => setTheme(v ? 'light' : 'dark')}
        />
      </section>
      <section>
        <p className={sectionCls}>Streamer mode</p>
        <SettingSwitch label="Streamer mode" value={streamer} onChange={setStreamer} />
        <p className="mt-2 px-2 text-xs text-on-surface-variant">
          Blurs server names, usernames, and DM names until hovered.
        </p>
      </section>
    </div>
  )
}

function Info({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className={sectionCls}>{title}</p>
      <div className="flex flex-col gap-2 text-sm text-on-surface-variant">{children}</div>
    </section>
  )
}

function InformationSection() {
  return (
    <div className="flex flex-col gap-8">
      <Info title="About RChat">
        <p>
          Anonymous chat with a Discord-style layout. Everything runs on the server you connect to;
          no external APIs, no telemetry, no email.
        </p>
      </Info>
      <Info title="Accounts and passwords">
        <p>
          Accounts are anonymous: no email, no phone, no recovery flow. A lost password means a lost
          account. Passwords are stored as argon2 hashes, never in plain text, and any non-empty
          password is accepted with no strength rules.
        </p>
        <p>
          Word passwords are an alternative: each username maps to a fixed set of 20 words, and the
          secret is your ordered pick of 7. Anyone can see any username&apos;s word set; only the
          ordered selection is private.
        </p>
        <p>
          Login attempts per username are throttled to one every 3 seconds, and over 1000 failures
          in a day lock the account until the next day. Login tokens never expire.
        </p>
      </Info>
      <Info title="Files and attachments">
        <p>
          Server uploads are capped at 25MB and deleted exactly one day after posting; the message
          stays and shows a removal notice. Uploaded blobs live in the server database.
        </p>
        <p>
          P2P attachments never touch the server. The file is stored in the sender&apos;s browser
          and transferred directly to viewers, so it is only available while the sender is online
          and still holding it. The sender picks an expiry (or indefinite) when sending.
        </p>
      </Info>
      <Info title="Voice and video">
        <p>
          Voice channels and calls are WebRTC connections directly between browsers, with no relay
          or external services; media never passes through the server. P2P calls likewise connect
          peer to peer.
        </p>
      </Info>
      <Info title="Servers and identity">
        <p>
          Lowercased usernames are user IDs, and lowercased server names are server IDs and also the
          invite codes; knowing a server&apos;s name is enough to join or view it. Password
          protected servers require the password first.
        </p>
        <p>
          Guests browse read-only with no account: they can view servers by name, receive live
          updates, and never appear in presence. Their server list lives in their own browser.
        </p>
      </Info>
      <Info title="Moderation">
        <p>
          Profanity filtering runs server-side on usernames, server names, channel names, and
          channel messages; DMs and passwords are exempt. Rate limits apply per IP across the API.
        </p>
      </Info>
    </div>
  )
}

function Menu() {
  const closeDialog = useStore(s => s.closeDialog)
  const [section, setSection] = useState<Section>('settings')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDialog])

  const sections: [Section, string][] = [
    ['settings', 'Settings'],
    ['information', 'Information'],
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
        <div className="max-w-lg pb-10">
          {section === 'settings' ? <SettingsSection /> : <InformationSection />}
        </div>
      </div>
    </div>
  )
}
