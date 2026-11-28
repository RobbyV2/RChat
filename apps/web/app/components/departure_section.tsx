'use client'

import { departure as departureFeature, type Departure } from '../lib/place/departure'
import { featureAt, isUnsupported } from '../lib/place/feature'
import type { Place } from '../lib/place/place'
import { useLive } from '../lib/place/react'
import { Button } from './controls'
import { Row } from './layout'

const LABEL = { leave: 'Leave server', forget: 'Remove from this device', delete: 'Delete server' }

function Body({ departure }: { departure: Departure }) {
  const { kind, line } = useLive(departure.state)
  if (kind === null) return null
  return (
    <Row gap="md" wrap data-departure={kind}>
      <p className="min-w-48 flex-1 text-xs text-on-surface-variant">{line}</p>
      <Button
        onClick={departure.go}
        variant={kind === 'delete' ? 'danger' : 'filled-danger'}
        size="md"
      >
        {LABEL[kind]}
      </Button>
    </Row>
  )
}

// The end of a server's settings: leaving it, removing it from this device, or deleting it.
export function DepartureSection({ place }: { place: Place }) {
  const here = featureAt(departureFeature, place)
  return isUnsupported(here) ? null : <Body departure={here} />
}
