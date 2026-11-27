import { useEffect, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '../../../apps/web/app/components/controls'
import { Row, Stack, Surface } from '../../../apps/web/app/components/layout'
import { CopyButton, QrCode } from '../../../apps/web/app/components/share_code'
import { askApp } from '../../../apps/web/app/lib/app_requests'
import { Name, Note, Title } from './parts'
import { useLive } from './store'

// Where another device takes an address.
function Steps({ web }: { web: boolean }) {
  return (
    <Stack gap="sm" place="flex-1 min-w-0">
      <Note>
        <strong>Desktop and mobile apps:</strong> enter the address at the first start, or choose
        Add an instance in the server rail.
      </Note>
      {web && (
        <Note>
          <strong>The web app on another address:</strong> choose Use another instance on the
          sign-in page, or Add an instance in the server rail.
        </Note>
      )}
      <Note>
        <strong>Then:</strong> log in, or choose Create account. On a phone, scanning the code opens
        the address in the browser.
      </Note>
    </Stack>
  )
}

// An address to copy or scan, with `beside` next to its code.
function Address({ address, beside }: { address: string; beside?: ReactNode }) {
  return (
    <Stack gap="md">
      <Row gap="sm">
        <code className="streamer text-sm break-all">{address}</code>
        <CopyButton text={address} label="Copy address" />
      </Row>
      <Row gap="lg" wrap align="start">
        <div className="streamer">
          <QrCode text={address} label="QR code of the address" size="sm" />
        </div>
        {beside}
      </Row>
    </Stack>
  )
}

// Hands the tab back to the app, which opens its Add an instance dialog.
function addInstance() {
  askApp('add_instance')
  const path = window.location.pathname
  window.location.assign(path.slice(0, path.lastIndexOf('/docs/') + 1) || '/')
}

// How to use an instance from an app. Docs an instance serves show its address; docs an app
// carries list the instances the app holds, for another device, and add one to this app. Docs on
// their own keep the page's text.
export function Connect() {
  const { place, here, instances } = useLive(
    useShallow(s => ({ place: s.place, here: s.here, instances: s.instances }))
  )
  const shown = place === 'instance' || place === 'app'
  useEffect(() => {
    document.body.classList.toggle('live-connect', shown)
  }, [shown])
  if (place === 'instance' && here) {
    const address = here.public_url || window.location.origin
    return (
      <Surface pad="lg" gap="md" aria-label="Use this instance in an app">
        <Title>Use this instance in an app</Title>
        <Note>
          These docs come from <Name>{here.name || new URL(address).host}</Name>. Its address:
        </Note>
        <Address address={address} beside={<Steps web />} />
      </Surface>
    )
  }
  if (place !== 'app') return null
  return (
    <Surface pad="lg" gap="md" aria-label="Your instances">
      <Title>Your instances</Title>
      <Row gap="sm" wrap>
        <Button variant="filled" size="md" icon={Plus} onClick={addInstance}>
          Add an instance
        </Button>
      </Row>
      {instances.length > 0 && (
        <Note>To use one on another device, copy its address or scan its code there.</Note>
      )}
      {instances.map(i => (
        <Surface key={i.origin} pad="md" gap="md" tone="low" radius="lg">
          <p className="text-sm font-medium text-on-surface">
            <Name>{i.name}</Name>
          </p>
          <Address address={i.origin} />
        </Surface>
      ))}
      {instances.length > 0 && <Steps web />}
    </Surface>
  )
}
