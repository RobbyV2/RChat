'use client'

import { useState } from 'react'
import { about as aboutFeature, type AboutGlyph, type PlaceAbout } from '../lib/place/about'
import { featureAt, isUnsupported } from '../lib/place/feature'
import type { Place } from '../lib/place/place'
import { useLive } from '../lib/place/react'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { NameInput } from './name'
import { P2pServerGlyph } from './p2p/p2p_server_glyph'
import { AboutEditor, ServerIcon } from './server_about'
import { ServerGlyph } from './server_rail'
import { FieldError } from './ui'

function Glyph({ glyph }: { glyph: AboutGlyph }) {
  if (glyph.kind === 'hosted')
    return <ServerGlyph name={glyph.server} displayName={glyph.displayName} animate />
  return (
    <P2pServerGlyph pic={glyph.pic} animate>
      <ServerIcon seed={glyph.seed} name={glyph.name} kind={glyph.icon} color={glyph.color} />
    </P2pServerGlyph>
  )
}

function Rename({
  about,
  name,
  max,
  locked,
}: {
  about: PlaceAbout
  name: string
  max: number | null
  locked: string | null
}) {
  const [text, setText] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const trimmed = text.trim()
  const dirty = trimmed !== '' && trimmed !== name
  return (
    <Stack gap="2xs">
      <Row
        as="form"
        gap="sm"
        align="end"
        onSubmit={e => {
          e.preventDefault()
          if (!dirty) return
          setError(null)
          void about.rename(trimmed).then(setError)
        }}
      >
        <Stack as="label" gap="2xs" place="min-w-0 flex-1">
          <span className="text-sm">Server name</span>
          <NameInput
            value={text}
            maxLength={max ?? undefined}
            disabled={locked !== null}
            onChange={e => setText(e.target.value)}
            aria-label="Server name"
          />
        </Stack>
        {locked === null && (
          <Button variant="filled" size="md" type="submit" disabled={!dirty}>
            Save
          </Button>
        )}
      </Row>
      {locked !== null && <p className="text-xs text-on-surface-variant">{locked}</p>}
      <FieldError message={error} />
    </Stack>
  )
}

function Body({ about }: { about: PlaceAbout }) {
  const s = useLive(about.state)
  if (!s.ready || !s.shown) return null
  return (
    <Stack gap="md" data-overview>
      <Rename
        key={s.name}
        about={about}
        name={s.name}
        max={s.nameMax}
        locked={s.canRename ? null : s.renameLocked}
      />
      <AboutEditor
        seed={s.seed}
        name={s.name}
        color={s.color}
        about={s.about}
        editable={s.editable}
        own={s.own}
        locked={s.locked}
        onSave={about.save}
        picture={
          s.picture
            ? {
                glyph: <Glyph glyph={s.glyph} />,
                source: {
                  ...s.picture,
                  upload: (file, crop) => about.upload(file, crop),
                  remove: about.removePicture,
                },
              }
            : undefined
        }
      />
    </Stack>
  )
}

// What a server is called and says about itself, at the top of its overview.
export function OverviewSection({ place }: { place: Place }) {
  const here = featureAt(aboutFeature, place)
  return isUnsupported(here) ? null : <Body about={here} />
}
