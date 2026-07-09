const THRESHOLD = 0.02
const HOLD_FRAMES = 12

interface Watched {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  sink: HTMLAudioElement
  buf: Float32Array<ArrayBuffer>
  speaking: boolean
  hold: number
}

export class SpeakingDetector {
  private ctx: AudioContext | null = null
  private watched = new Map<string, Watched>()
  private raf: number | null = null
  onSpeak: (id: string, speaking: boolean) => void = () => {}

  watch(id: string, stream: MediaStream) {
    const track = stream.getAudioTracks()[0]
    if (!track) return
    this.unwatch(id)
    const ctx = this.ensure()
    const tapped = new MediaStream([track])
    const source = ctx.createMediaStreamSource(tapped)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const sink = new Audio()
    sink.muted = true
    sink.srcObject = tapped
    void sink.play().catch(() => {})
    this.watched.set(id, {
      source,
      analyser,
      sink,
      buf: new Float32Array(analyser.fftSize),
      speaking: false,
      hold: 0,
    })
    this.start()
  }

  unwatch(id: string) {
    const w = this.watched.get(id)
    if (!w) return
    this.release(w)
    this.watched.delete(id)
    if (w.speaking) this.onSpeak(id, false)
    if (this.watched.size === 0) this.stop()
  }

  clear() {
    for (const w of this.watched.values()) this.release(w)
    this.watched.clear()
    this.stop()
  }

  private release(w: Watched) {
    w.source.disconnect()
    w.sink.pause()
    w.sink.srcObject = null
  }

  private ensure(): AudioContext {
    const ctx = this.ctx ?? new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  private stop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
  }

  private start() {
    if (this.raf !== null) return
    const tick = () => {
      for (const [id, w] of this.watched) {
        w.analyser.getFloatTimeDomainData(w.buf)
        let sum = 0
        for (const v of w.buf) sum += v * v
        const rms = Math.sqrt(sum / w.buf.length)
        if (rms > THRESHOLD) w.hold = HOLD_FRAMES
        else if (w.hold > 0) w.hold -= 1
        const speaking = w.hold > 0
        if (speaking !== w.speaking) {
          w.speaking = speaking
          this.onSpeak(id, speaking)
        }
      }
      this.raf = this.watched.size > 0 ? requestAnimationFrame(tick) : null
    }
    this.raf = requestAnimationFrame(tick)
  }
}
