'use client'

import { useState } from 'react'
import { fmtSize } from '../lib/bytes'
import { clearApiHistory, useApiDoc } from '../lib/api_console'
import { isMac, paletteShortcut, type IndexMode } from '../lib/palette'
import { FULL_MAX_BYTES } from '../lib/palette_index'
import { clearUsage, setIndexMode, usePaletteUi } from '../lib/palette_store'
import { clearIndex, setIndexModeNow, useIndexStatus } from '../lib/palette_sync'
import { useStore } from '../lib/store'
import { Choice } from './friends'
import { dangerBtn, sectionCls, textBtn } from './ui'

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
  const guest = useStore(s => s.guest)
  const wanted = usePaletteUi(s => s.prefs.index)
  const status = useIndexStatus()
  const used = usePaletteUi(s => Object.keys(s.prefs.used).length)
  const requests = useApiDoc(s => s.history.items.length)
  const [cleared, setCleared] = useState(false)
  const options = guest ? MODES.filter(m => m.value !== 'full') : MODES
  const shown = guest && wanted === 'full' ? 'loaded' : wanted

  const pick = (mode: IndexMode) => {
    setIndexMode(mode)
    setIndexModeNow(mode)
    setCleared(false)
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className={sectionCls}>Command palette</p>
        <p className="px-2 text-sm text-on-surface-variant">
          Press {paletteShortcut(isMac())} anywhere, or use the palette button at the top on small
          screens. Start with # for channels, @ for people, &gt; for commands, / for the API and ?
          for help.
        </p>
      </section>
      <section>
        <p className={sectionCls}>Search index</p>
        <div className="px-2">
          <Choice label="Index" value={shown} options={options} onChange={pick} />
          <p className="mt-2 text-xs text-on-surface-variant">{MODE_NOTE[shown]}</p>
          <p className="mt-2 text-xs text-on-surface-variant">
            Only what you can see is indexed. Leaving a server, losing access to a channel, deleted
            messages and blocked people are removed from it.
          </p>
          {guest && (
            <p className="mt-2 text-xs text-on-surface-variant">Guests can index in memory only.</p>
          )}
          <dl
            data-index-size
            className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-on-surface-variant"
          >
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
          </dl>
          {status.error && (
            <p role="alert" className="mt-2 text-xs text-error">
              {status.error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void clearIndex().then(() => {
                  setCleared(true)
                })
              }
              className={dangerBtn}
            >
              Clear index
            </button>
            {cleared && <span className="text-xs text-on-surface-variant">Cleared</span>}
          </div>
        </div>
      </section>
      <section>
        <p className={sectionCls}>History</p>
        <div className="flex flex-col gap-2 px-2 text-sm text-on-surface-variant">
          <p>
            The palette ranks what you use often first. API console requests are kept here without
            tokens or secret fields.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!used}
              onClick={clearUsage}
              className={`${textBtn} disabled:opacity-40`}
            >
              Forget recent commands
            </button>
            <button
              type="button"
              disabled={!requests}
              onClick={clearApiHistory}
              className={`${textBtn} disabled:opacity-40`}
            >
              Clear request history
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
