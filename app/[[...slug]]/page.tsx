import AppShell from './app_shell'

export const dynamic = 'force-static'

export function generateStaticParams() {
  return [{ slug: [] }]
}

export default function Page() {
  return <AppShell />
}
