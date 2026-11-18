// A send the server answered within this long tells its clock closely enough.
export const CLOCK_ANSWER_MS = 10_000

// How far the server's clock is ahead of this device in milliseconds, from one send: `sent` and
// `answered` are device times around the request, `created` the Unix seconds the server stored.
export const clockSample = (sent: number, answered: number, created: number): number | null => {
  const took = answered - sent
  if (took < 0 || took > CLOCK_ANSWER_MS) return null
  return created * 1000 - (sent + answered) / 2
}
