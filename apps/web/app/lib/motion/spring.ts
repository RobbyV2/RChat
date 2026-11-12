// A damped spring of mass 1, sampled into a CSS `linear()` easing with `points` steps, and the
// time in ms it takes to settle within 0.1%, at most 1000.
export const spring = (
  stiffness: number,
  damping: number,
  points = 24
): { easing: string; duration: number } => {
  const w0 = Math.sqrt(stiffness)
  const zeta = damping / (2 * w0)
  const x = (t: number) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      return (
        1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
      )
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  }
  let settle = 0
  for (let t = 0; t <= 1; t += 0.001) if (Math.abs(1 - x(t)) > 0.001) settle = t
  const duration = Math.min(1000, Math.max(50, Math.round((settle + 0.001) * 1000)))
  const stops = Array.from(
    { length: points + 1 },
    (_, i) => +x((i / points) * (duration / 1000)).toFixed(4)
  )
  stops[stops.length - 1] = 1
  return { easing: `linear(${stops.join(', ')})`, duration }
}
