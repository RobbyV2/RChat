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
      <Surface
        pad="lg"
        gap="2xs"
        tone="plain"
        align="center"
        justify="center"
        text="sm"
        ink="muted"
        look="min-h-32 border border-dashed border-outline-variant text-center"
      >
        Hidden in streamer mode
        <Button onClick={reveal.show}>Show</Button>
      </Surface>
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
