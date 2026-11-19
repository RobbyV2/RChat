'use client'

import dynamic from 'next/dynamic'
import { useStore } from '../../lib/store'

const AdminRoot = dynamic(() => import('./admin_page'), { ssr: false })

// Loads the site administration page's code only in the site admin's session.
export function AdminHost() {
  const isSiteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  return isSiteAdmin ? <AdminRoot /> : null
}
