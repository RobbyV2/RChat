'use client'

import { useState, type ReactNode } from 'react'
import {
  Ban,
  Hash,
  History,
  IdCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Paperclip,
  Puzzle,
  ScrollText,
  Shield,
  Ticket,
  Trash2,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import { isUnsupported } from '../lib/place/feature'
import { useFeature, useLive } from '../lib/place/react'
import { settings, type PlaceSettings } from '../lib/place/settings'
import type { RoomSettingsSection, ServerSettingsSection } from '../lib/server_settings_sections'
import { SettingsPage, type PageSection } from './settings_page'

const ICONS: Record<ServerSettingsSection | RoomSettingsSection, LucideIcon> = {
  invites: Ticket,
  overview: LayoutDashboard,
  widgets: Puzzle,
  messages: MessageSquare,
  system: MessageSquare,
  uploads: Paperclip,
  profiles: IdCard,
  access: KeyRound,
  roles: Shield,
  channels: Hash,
  history: History,
  members: Users,
  bans: Ban,
  integrations: Webhook,
  audit: ScrollText,
  modlog: ScrollText,
  leave: LogOut,
  delete: Trash2,
}

const iconOf = (id: string): LucideIcon => (ICONS as Record<string, LucideIcon>)[id] ?? Hash

// The settings of the server or room around it: the sections it shows you, each drawn by
// `render`. `first`: the section to open, as whatever opened the settings asks; null opens the
// list on phones and the first section on wide screens.
export function ServerSettingsPage(props: {
  first: string | null
  render: (id: string) => ReactNode
  actor: ReactNode
  lead?: ReactNode
}) {
  const here = useFeature(settings)
  return isUnsupported(here) ? null : <Sections place={here} {...props} />
}

function Sections({
  place,
  first,
  render,
  actor,
  lead,
}: {
  place: PlaceSettings
  first: string | null
  render: (id: string) => ReactNode
  actor: ReactNode
  lead?: ReactNode
}) {
  const shown = useLive(place.sections)
  const [picked, setPicked] = useState<string | null>(first)
  const [seen, setSeen] = useState(first)
  const [row, setRow] = useState<string | null>(null)
  if (seen !== first) {
    setSeen(first)
    if (first !== null) setPicked(first)
  }
  if (shown === null) return null
  const sections: PageSection[] = shown.map(s => ({
    id: s.id,
    label: s.label,
    icon: iconOf(s.id),
    rows: s.rows,
    render: () => render(s.id),
  }))
  return (
    <SettingsPage
      title="Server Settings"
      sections={sections}
      active={picked}
      row={row}
      onSection={(id, at) => {
        setPicked(id)
        setRow(at ?? null)
      }}
      onClose={place.close}
      actor={actor}
      lead={lead}
      layer="dialog"
    />
  )
}
