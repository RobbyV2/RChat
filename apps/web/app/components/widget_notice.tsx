import { systemParts } from '../lib/system_messages'
import type { Message } from '../lib/types'
import { NameWithUsername } from './display_name'
import { ShortTime } from './timestamp'

// A join, leave or pin line in a widget's message list, worded as in the channel.
export function WidgetNotice({ message }: { message: Message }) {
  const [before, after] = message.kind === 'pin' ? ['', ' pinned a message.'] : systemParts(message)
  return (
    <article
      data-mid={message.id}
      data-system={message.kind}
      className="min-w-0 break-words px-1 py-1 text-sm text-on-surface-variant"
    >
      {before}
      <span className="streamer font-medium text-on-surface">
        <NameWithUsername user={message.author} />
      </span>
      {after} <ShortTime ts={message.created_at} className="text-xs opacity-70" />
    </article>
  )
}
