import { Metadata } from 'next'
import Dashboard from '@/app/components/dashboard/Dashboard'

interface Props {
  params: Promise<{
    dmId: string
  }>
}

export const metadata: Metadata = {
  title: 'Direct Messages | RChat',
  description: 'Your private conversations.',
}

export default async function DmPage({ params }: Props) {
  const { dmId } = await params
  return <Dashboard initialDmId={dmId} />
}
