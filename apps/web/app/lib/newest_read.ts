// Reads where only the newest one may apply its result. A read that a newer one replaced
// resolves only once the newest has finished, so whoever waits for a read sees fresh data.
export type NewestReads = {
  read: (run: (live: () => boolean) => Promise<void>) => Promise<void>
  drop: () => void
}

export function newestReads(): NewestReads {
  let epoch = 0
  let last: Promise<void> = Promise.resolve()
  return {
    read: async run => {
      const mine = ++epoch
      const own = run(() => mine === epoch)
      last = own
      await own
      for (let seen = own; seen !== last;) {
        seen = last
        await seen.catch(() => undefined)
      }
    },
    drop: () => {
      epoch += 1
    },
  }
}
