'use client'

import { Button } from '../controls'
import { Grid, Stack, Surface } from '../layout'
import { useReveal } from './reveal'

// The words in order. In streamer mode they stay covered until Show, and again each time streamer
// mode is turned on.
export function PhraseWords({ words }: { words: string[] }) {
  const reveal = useReveal()
  if (reveal.hidden)
    return (
      <div className="flex min-h-32 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-outline-variant p-4 text-center text-sm text-on-surface-variant">
        Hidden in streamer mode
        <Button onClick={reveal.show}>Show</Button>
      </div>
    )
  return (
    <Stack gap="2xs">
      <Grid as="ol" aria-label="Backup phrase" cols={{ base: 2, sm: 3 }} gap="sm">
        {words.map((w, i) => (
          <Surface as="li" key={i} pad="md" radius="lg">
            <span className="font-mono text-sm text-on-surface tabular-nums">{`${i + 1}. ${w}`}</span>
          </Surface>
        ))}
      </Grid>
      {reveal.streamer && (
        <Button onClick={reveal.hide} place="self-start">
          Hide
        </Button>
      )}
    </Stack>
  )
}
