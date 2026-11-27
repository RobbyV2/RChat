'use client'

import dynamic from 'next/dynamic'
import { useStore } from '../../lib/store'

const AdminRoot = dynamic(() => import('./admin_page'), { ssr: false })

const AdminDialogs = dynamic(() => import('./dialogs'), { ssr: false })

const StaffViewPrompt = dynamic(() => import('./staff_view'), { ssr: false })

export function AdminDialogHost() {
  const open = useStore(s => !!s.me?.is_site_admin && s.activeDialog !== null)
  return open ? <AdminDialogs /> : null
}

// Loads the site administration page's code only in the site admin's session.
export function AdminHost() {
  const isSiteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  return isSiteAdmin ? (
    <>
      <AdminRoot />
      <StaffViewPrompt />
    </>
  ) : null
}
