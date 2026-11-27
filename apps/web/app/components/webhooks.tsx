'use client'
import { personCalled } from '../lib/names'
import { Name } from './name'

import { asAccount } from '../lib/people'
import { ListRow } from './controls'
import { Grid, Inset, Lift, Row, Stack, Surface } from './layout'
import type { ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { embedColor, fieldRows, safeLink, webhookIdOf } from '../lib/webhooks'
import type { RichEmbed, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { useCopied } from '../lib/use_copied'
import { sharing } from '../lib/platform'

// Always shown next to a webhook's name, whatever name it posted with.
export function WebhookBadge() {
  return (
    <Inset
      title="Posted through a webhook, not by a member"
      as="span"
      pad="2xs"
      inset="bar"
      look="rounded-md bg-tertiary-container text-3xs leading-4 font-semibold tracking-wide text-on-tertiary-container"
      place="shrink-0 self-center"
    >
      WEBHOOK
    </Inset>
  )
}

type CardText = (s: string) => ReactNode
// A link as messages show it: its menu, and the warning before it opens another site.
type CardLink = (href: string, className: string, children: ReactNode) => ReactNode

function RichCard({
  embed,
  text,
  line,
  link: Link,
}: {
  embed: RichEmbed
  text: CardText
  line: CardText
  link: CardLink
}) {
  const color = embedColor(embed.color)
  const link = safeLink(embed.url)
  const rows = fieldRows(embed.fields ?? [])
  return (
    <div
      style={color ? { borderLeftColor: color } : undefined}
      className="w-full max-w-md min-w-0 rounded-lg border-l-4 border-outline bg-surface-container"
    >
      <Surface pad="md" tone="plain" gap="sm">
        {(embed.title || embed.description) && (
          <Stack gap="3xs">
            {embed.title &&
              (link ? (
                Link(
                  link,
                  'block text-sm font-semibold break-words text-primary hover:underline',
                  line(embed.title)
                )
              ) : (
                <p className="text-sm font-semibold break-words text-on-surface">
                  {line(embed.title)}
                </p>
              ))}
            {embed.description && (
              <div className="text-sm break-words text-on-surface">{text(embed.description)}</div>
            )}
          </Stack>
        )}
        {rows.map((row, i) => (
          <Grid key={i} cols={row.length > 1 ? { base: 1, sm: 3 } : 1} gap="sm">
            {row.map((f, j) => (
              <div key={j} className="min-w-0">
                <p className="text-xs font-semibold break-words text-on-surface">{line(f.name)}</p>
                <div className="text-sm break-words text-on-surface-variant">{text(f.value)}</div>
              </div>
            ))}
          </Grid>
        ))}
        {embed.footer?.text && (
          <p className="text-xs break-words text-on-surface-variant">{line(embed.footer.text)}</p>
        )}
      </Surface>
    </div>
  )
}

export function RichEmbeds({
  embeds,
  text,
  line,
  link,
}: {
  embeds: RichEmbed[]
  text: CardText
  line: CardText
  link: CardLink
}) {
  if (!embeds.length) return null
  return (
    <Stack gap="2xs">
      {embeds.map((e, i) => (
        <RichCard key={i} embed={e} text={text} line={line} link={link} />
      ))}
    </Stack>
  )
}

// The small profile card of a webhook author: no member details, no DM.
export function WebhookProfile({
  user,
  sheet,
  titleId,
}: {
  user: UserRef
  sheet: boolean
  titleId: string
}) {
  const [copied, flash] = useCopied()
  const id = webhookIdOf(user.username)
  return (
    <>
      <div
        aria-hidden
        className={`shrink-0 bg-surface-container-highest ${sheet ? 'h-20' : 'h-14'}`}
      />
      <Inset pad="lg" inset="sides">
        <Stack gap="sm">
          <Lift by="2xl">
            <Row gap="sm" align="end" justify="between">
              <Surface as="span" pad="xs" tone="high" radius="full" place="shrink-0">
                <UserAvatar person={asAccount(user, 'webhook')} size={64} />
              </Surface>
              <span>
                <WebhookBadge />
              </span>
            </Row>
          </Lift>
          <Name
            as="p"
            id={titleId}
            of={personCalled(user.display_name, user.username)}
            look="line-clamp-2 text-lg leading-6 font-semibold break-words text-on-surface"
          />
          <Surface pad="md" tone="low" radius="lg">
            <p className="text-sm text-on-surface-variant">
              Posted by an app or service through a webhook. It is not a member and cannot get
              messages.
            </p>
          </Surface>
          {id !== null && (
            <ListRow
              icon={copied ? Check : Copy}
              label={copied ? 'Copied' : 'Copy Webhook ID'}
              onClick={() => void sharing().copyText(String(id)).then(flash)}
            />
          )}
        </Stack>
      </Inset>
    </>
  )
}
