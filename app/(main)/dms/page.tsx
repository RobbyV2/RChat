import { Metadata } from 'next'
import Dashboard from '@/app/components/dashboard/Dashboard'

export const metadata: Metadata = {
  title: 'Direct Messages | RChat',
}

export default function DmsPage() {
  return <Dashboard initialViewMode="dms" />
}
