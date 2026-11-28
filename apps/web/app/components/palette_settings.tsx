'use client'

import { useState } from 'react'
import { fmtSize } from '../lib/bytes'
import { useApiDoc } from '../lib/api_console'
import { isMac, paletteShortcut, type IndexMode } from '../lib/palette'
import { FULL_MAX_BYTES } from '../lib/palette_index'
import { usePaletteUi } from '../lib/palette_store'
import { useIndexStatus } from '../lib/palette_sync'
import { useStore } from '../lib/store'
import { useAccount } from '../lib/client/react'
import { Choice } from './friends'
import { Button } from './controls'
import { Row, Stack, Grid } from './layout'
import { SettingNotes } from './settings_fields'
import { sectionCls } from './ui'

const MODES: { value: IndexMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'loaded', label: 'Loaded only' },
  { value: 'full', label: 'Full' },
]

const MODE_NOTE: Record<IndexMode, string> = {
  off: 'Nothing is indexed. The palette still finds servers, channels, people and commands.',
  loaded:
    'Messages and members you load are indexed in memory for this session only. Nothing is kept on this device.',
  full: `Also kept on this device until you log out, and filled in the background with recent messages of your servers and DMs, up to ${fmtSize(FULL_MAX_BYTES)}. Older messages you scrolled to drop out at the next refill, every 12 hours.`,
}

// Settings > Command palette: the local index and the palette's local history.
export function PaletteSettingsSection() {
  const { apiDoc, indexer, palettePrefs, lifetime } = useAccount()
  const guest = useStore(s => s.guest)
  const wanted = usePaletteUi(s => s.prefs.index)
  const status = useIndexStatus()
  const used = usePaletteUi(s => Object.keys(s.prefs.used).length)
  const requests = useApiDoc(s => s.history.items.length)
  const [cleared, setCleared] = useState(false)
  const options = guest ? MODES.filter(m => m.value !== 'full') : MODES
  const shown = guest && wanted === 'full' ? 'loaded' : wanted

  const pick = (mode: IndexMode) => {
    palettePrefs.setIndexMode(mode)
    indexer.setIndexModeNow(mode)
    setCleared(false)
  }

  return (
    <Stack gap="2xl">
      <section>
        <SettingNotes>
          <p className="text-sm text-on-surface-variant">
            Press {paletteShortcut(isMac())} anywhere, or use the palette button at the top on small
            screens. Start with # for channels, @ for people, &gt; for commands, / for the API and ?
            for help.
          </p>
        </SettingNotes>
      </section>
      <section>
        <p className={sectionCls}>Search index</p>
        <SettingNotes gap="md">
          <Stack gap="sm">
            <Choice label="Index" value={shown} options={options} onChange={pick} />
            <p className="text-xs text-on-surface-variant">{MODE_NOTE[shown]}</p>
            <p className="text-xs text-on-surface-variant">
              Only what you can see is indexed. Leaving a server, losing access to a channel,
              deleted messages and blocked people are removed from it.
            </p>
            {guest && (
              <p className="text-xs text-on-surface-variant">Guests can index in memory only.</p>
            )}
          </Stack>
          <Stack gap="sm">
            <Grid data-index-size as="dl" cols="pair" gap="lg" lineGap="2xs" text="sm" ink="muted">
              <dt>Size</dt>
              <dd className="text-on-surface">{fmtSize(status.bytes)}</dd>
              <dt>Messages</dt>
              <dd className="text-on-surface">{status.messages}</dd>
              <dt>Members</dt>
              <dd className="text-on-surface">{status.docs - status.messages}</dd>
              {status.state === 'backfilling' && (
                <>
                  <dt>Filling</dt>
                  <dd className="text-on-surface">
                    {status.done} of {status.total} conversations
                  </dd>
                </>
              )}
              {status.state === 'loading' && (
                <>
                  <dt>Status</dt>
                  <dd className="text-on-surface">Loading</dd>
                </>
              )}
            </Grid>
            {status.error && (
              <p role="alert" className="text-xs text-error">
                {status.error}
              </p>
            )}
          </Stack>
          <Row gap="sm" wrap>
            <Button
              variant="danger"
              onClick={() =>
                void indexer.clearIndex().then(lifetime.inSession(() => setCleared(true)))
              }
            >
              Clear index
            </Button>
            {cleared && <span className="text-xs text-on-surface-variant">Cleared</span>}
          </Row>
        </SettingNotes>
      </section>
      <section>
        <p className={sectionCls}>History</p>
        <SettingNotes>
          <p className="text-sm text-on-surface-variant">
            The palette ranks what you use often first. API console requests are kept here without
            tokens or secret fields.
          </p>
          <Row gap="sm" wrap>
            <Button disabled={!used} onClick={palettePrefs.clearUsage}>
              Forget recent commands
            </Button>
            <Button disabled={!requests} onClick={apiDoc.clearApiHistory}>
              Clear request history
            </Button>
          </Row>
        </SettingNotes>
      </section>
    </Stack>
  )
}
