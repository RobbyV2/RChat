'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import { ask, asked, previewUrlOf, sendTo } from '../lib/asks'
import { useAccount } from '../lib/client/react'
import { notAName } from '../lib/names'
import type { Gif, GifPage } from '../lib/types'
import { Button, MediaButton } from './controls'
import { Grid, Inset, Row, Stack } from './layout'
import { Loaded, useAccountRequest } from './loaded'
import { fieldCls } from './ui'

// The address of a GIF's preview on the account's instance.
const previewOf = (account: ReturnType<typeof useAccount>, gif: Gif) =>
  previewUrlOf(account, gif.preview.replace(/^\/api\/v1(?=\/)/, ''))

function Tile({ gif, onPick }: { gif: Gif; onPick: (gif: Gif) => void }) {
  const account = useAccount()
  const label = gif.title.trim() || 'GIF'
  return (
    <MediaButton
      data-gif={gif.id}
      title={notAName(label)}
      label={notAName(label)}
      onClick={() => onPick(gif)}
    >
      <img
        src={previewOf(account, gif)}
        alt=""
        width={gif.width}
        height={gif.height}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-auto w-full bg-surface-container-highest object-cover"
      />
    </MediaButton>
  )
}

function Results({ q, onPick }: { q: string; onPick: (gif: Gif) => void }) {
  const [pages, setPages] = useState<{ q: string; next: string | null; more: Gif[] }>({
    q,
    next: null,
    more: [],
  })
  const held = pages.q === q ? pages : { q, next: null, more: [] }
  const load = useAccountRequest(
    () =>
      asked(q === '' ? ask.trendingGifs(null) : ask.searchGifs(q, null), (page: GifPage) => page),
    [q],
    { delayMs: q === '' ? 0 : 300, empty: page => page.items.length === 0 }
  )
  const account = useAccount()
  const [busy, setBusy] = useState(false)
  const more = async (next: string) => {
    setBusy(true)
    try {
      const page = await sendTo(
        account,
        q === '' ? ask.trendingGifs(next) : ask.searchGifs(q, next)
      )
      setPages({ q, next: page.next ?? null, more: [...held.more, ...page.items] })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Loaded load={load} empty="No GIFs match that." what="the GIFs">
      {first => {
        const items = [...first.items, ...held.more]
        const next = held.more.length ? held.next : (first.next ?? null)
        return (
          <Stack gap="sm">
            <Grid cols={{ base: 2, sm: 3 }} gap="xs" data-gif-results>
              {items.map(gif => (
                <Tile key={gif.id} gif={gif} onPick={onPick} />
              ))}
            </Grid>
            {next && (
              <Button busy={busy} onClick={() => void more(next)} place="self-center">
                More
              </Button>
            )}
          </Stack>
        )
      }}
    </Loaded>
  )
}

// GIF search on the account's instance, which asks its provider: what trends while nothing is
// typed. `onPick` takes the GIF's link.
export function GifPanel({ onPick }: { onPick: (url: string) => void }) {
  const [text, setText] = useState('')
  return (
    <Inset pad="md">
      <Stack gap="sm">
        <Row gap="xs">
          <Search size={16} aria-hidden className="shrink-0 text-on-surface-variant" />
          <input
            autoFocus
            value={text}
            maxLength={100}
            onChange={e => setText(e.target.value)}
            placeholder="Search GIFs"
            aria-label="Search GIFs"
            className={fieldCls}
          />
        </Row>
        <Results q={text.trim()} onPick={gif => onPick(gif.url)} />
        <p className="text-xs text-on-surface-variant">
          {notAName('GIFs come through this site.')}
        </p>
      </Stack>
    </Inset>
  )
}
