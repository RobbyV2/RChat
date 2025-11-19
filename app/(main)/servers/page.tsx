import { Metadata } from 'next'
import Dashboard from '@/app/components/dashboard/Dashboard'

export const metadata: Metadata = {
  title: 'Servers | RChat',
}

export default function ServersPage() {
  return <Dashboard />
}
