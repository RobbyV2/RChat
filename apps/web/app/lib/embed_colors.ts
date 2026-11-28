import { contrast, mix, MIN_NON_TEXT, THEME_ON_SURFACE } from './server_colors'
import type { Theme } from './types'
import { embedColor } from './webhooks'

// The left bar of a link preview or rich embed: the page's own color (`Embed.color`, from its
// theme-color), else a known site's, else none (the theme's primary); always made readable on
// the card's surface in the theme on screen. Nothing here asks anyone anything.

// The card's surface (`surface-container` in globals.css).
export const CARD_SURFACE: Record<Theme, string> = { dark: '#211f26', light: '#f3edf7' }

interface Site {
  hosts: string[]
  dark: string
  light: string
}

const site = (hosts: string[], dark: string, light = dark): Site => ({ hosts, dark, light })

export const SITE_COLORS: readonly Site[] = [
  site(['youtube.com', 'youtu.be', 'youtube-nocookie.com'], '#ff0000'),
  site(['x.com', 'twitter.com'], '#ffffff', '#0f1419'),
  site(['github.com', 'github.io'], '#e6edf3', '#24292f'),
  site(['reddit.com', 'redd.it'], '#ff4500'),
  site(['twitch.tv'], '#9146ff'),
  site(['spotify.com', 'spotify.link'], '#1db954'),
  site(['discord.com', 'discord.gg', 'discordapp.com'], '#5865f2'),
  site(['steampowered.com', 'steamcommunity.com'], '#66c0f4'),
  site(['wikipedia.org', 'wikimedia.org'], '#a2a9b1'),
  site(['bsky.app'], '#0085ff'),
  site(['mastodon.social', 'mastodon.online', 'joinmastodon.org'], '#6364ff'),
  site(['stackoverflow.com', 'stackexchange.com'], '#f48024'),
  site(['gitlab.com'], '#fc6d26'),
  site(['codeberg.org'], '#2185d0'),
  site(['vimeo.com'], '#1ab7ea'),
  site(['soundcloud.com'], '#ff5500'),
]

const HEX = /^#[0-9a-f]{6}$/

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

// A known site's color for `url` in `theme`, by its host or a parent domain.
export const siteColor = (url: string, theme: Theme): string | null => {
  const host = hostOf(url)
  if (!host) return null
  const hit = SITE_COLORS.find(s => s.hosts.some(h => host === h || host.endsWith(`.${h}`)))
  return hit ? hit[theme] : null
}

// `color`, or the nearest step toward the theme's text color that stands out from the card
// (3:1, like other parts that are not text).
export const legibleAccent = (color: string, theme: Theme): string => {
  const c = color.toLowerCase()
  const surface = CARD_SURFACE[theme]
  for (let step = 0; step <= 10; step += 1) {
    const out = step === 0 ? c : mix(c, THEME_ON_SURFACE[theme], step / 10)
    if (contrast(out, surface) >= MIN_NON_TEXT) return out
  }
  return THEME_ON_SURFACE[theme]
}

// The bar of a link preview; null keeps the theme's primary.
export const previewAccent = (
  embed: { url: string; color?: string | null },
  theme: Theme
): string | null => {
  const own = typeof embed.color === 'string' && HEX.test(embed.color) ? embed.color : null
  const color = own ?? siteColor(embed.url, theme)
  return color ? legibleAccent(color, theme) : null
}

// The bar of a rich embed (`0xRRGGBB`); null keeps the neutral outline.
export const cardAccent = (color: number | null | undefined, theme: Theme): string | null => {
  const hex = embedColor(color)
  return hex ? legibleAccent(hex, theme) : null
}
