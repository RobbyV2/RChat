'use client'

import { useMemo } from 'react'
import {
  LayoutDashboard,
  ScrollText,
  Server,
  ToggleRight,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { featureSearchRows } from '../../lib/admin_rows'
import { useStore } from '../../lib/store'
import type { AdminSection } from '../../lib/view'
import { SettingsPage, type PageSection } from '../settings_page'
import AdminDialogs from './dialogs'
import { AuditSection } from './audit'
import { DangerSection } from './danger'
import { FeaturesSection } from './features'
import { OverviewSection, OverviewSummary } from './overview'
import { ServerPage, ServersSection } from './servers'
import { UserPage, UsersSection } from './users'

const SECTIONS: Record<AdminSection, { label: string; icon: LucideIcon }> = {
  overview: { label: 'Overview', icon: LayoutDashboard },
  features: { label: 'Features', icon: ToggleRight },
  users: { label: 'Users', icon: Users },
  servers: { label: 'Servers', icon: Server },
  audit: { label: 'Audit log', icon: ScrollText },
  danger: { label: 'Danger zone', icon: TriangleAlert },
}

const isSection = (id: string | null): id is AdminSection =>
  id !== null && Object.hasOwn(SECTIONS, id)

function Page() {
  const place = useStore(s => s.adminPage)
  const openAdmin = useStore(s => s.openAdmin)
  const closeAdmin = useStore(s => s.closeAdmin)
  const item = place?.item ?? null
  const sections = useMemo((): PageSection[] => {
    const body: Record<AdminSection, PageSection['render']> = {
      overview: () => <OverviewSection />,
      features: () => <FeaturesSection />,
      users: () => (item === null ? <UsersSection /> : <UserPage key={item} username={item} />),
      servers: () => (item === null ? <ServersSection /> : <ServerPage key={item} name={item} />),
      audit: () => <AuditSection />,
      danger: () => <DangerSection />,
    }
    return (Object.keys(SECTIONS) as AdminSection[]).map(id => ({
      id,
      ...SECTIONS[id],
      rows:
        id === 'features'
          ? featureSearchRows()
          : id === 'danger'
            ? [
                {
                  section: 'danger',
                  id: 'delete_message',
                  label: 'Delete a message',
                  line: 'Removes one message for everyone, by its id.',
                },
              ]
            : undefined,
      render: body[id],
    }))
  }, [item])
  if (!place) return null
  return (
    <SettingsPage
      title="Site administration"
      sections={sections}
      active={place.section}
      row={place.row}
      heading={item ?? undefined}
      headingName
      summary={<OverviewSummary />}
      onSection={(id, row) => openAdmin(isSection(id) ? id : null, null, row ?? null)}
      onBack={item === null ? undefined : () => openAdmin(place.section)}
      onClose={closeAdmin}
    />
  )
}

// The site administration page and the confirm dialogs of its account actions. Only the site
// admin's browser loads this module.
export default function AdminRoot() {
  return (
    <>
      <Page />
      <AdminDialogs />
    </>
  )
}
