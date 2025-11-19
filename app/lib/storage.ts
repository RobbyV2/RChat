interface GuestPreferences {
  lastVisitedServerName?: string
  lastVisitedChannelId?: string
  visitedServers: string[]
  theme?: 'light' | 'dark'
}

const GUEST_PREFS_KEY = 'rchat_guest_preferences'

export const guestStorage = {
  getPreferences(): GuestPreferences {
    if (typeof window === 'undefined') {
      return { visitedServers: [] }
    }

    const stored = localStorage.getItem(GUEST_PREFS_KEY)
    if (!stored) {
      return { visitedServers: [] }
    }

    try {
      return JSON.parse(stored)
    } catch {
      return { visitedServers: [] }
    }
  },

  setPreferences(prefs: GuestPreferences): void {
    if (typeof window === 'undefined') return

    try {
      localStorage.setItem(GUEST_PREFS_KEY, JSON.stringify(prefs))
    } catch (err) {
      console.error('Failed to save guest preferences:', err)
    }
  },

  setLastVisited(serverName: string, channelId?: string): void {
    const prefs = this.getPreferences()
    prefs.lastVisitedServerName = serverName
    if (channelId) {
      prefs.lastVisitedChannelId = channelId
    }

    if (!prefs.visitedServers.includes(serverName)) {
      prefs.visitedServers.push(serverName)
    }

    this.setPreferences(prefs)
  },

  clearPreferences(): void {
    if (typeof window === 'undefined') return
    localStorage.removeItem(GUEST_PREFS_KEY)
  },
}
