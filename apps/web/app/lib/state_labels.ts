import { labellerFor, type NameLabeller } from './names'
import { maskProfanity, showText } from './profanity'
import type { RChatState } from './store_types'

type Viewer = Pick<RChatState, 'streamer' | 'profanityReady' | 'me'>

const mineIn = (s: Viewer) => (who: string | null) => who !== null && who === s.me?.username

// Labels for the names lib code shows as text (a confirmation, a menu row): streamer mode and the
// viewer's filter of this account.
export const stateLabels = (s: Viewer): NameLabeller =>
  labellerFor(s.streamer, s.profanityReady ? maskProfanity : showText, mineIn(s))

// Labels of rows drawn marked as a name: the viewer's filter only, as the mark hides the row in
// streamer mode and shows it on hover.
export const markedStateLabels = (s: Viewer): NameLabeller =>
  labellerFor(false, s.profanityReady ? maskProfanity : showText, mineIn(s))
