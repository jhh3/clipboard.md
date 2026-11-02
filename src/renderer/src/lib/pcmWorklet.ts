/**
 * AudioWorklet that turns the mic into 16 kHz mono Float32 PCM — what Parakeet
 * eats — so dictation never encodes, writes or decodes a file.
 *
 * While the mic is open but no take is running it only fills a short pre-roll ring,
 * so the first syllable spoken as the key goes down is part of the take. Messages:
 *   'start'  → posts the pre-roll, then a chunk every ~100 ms
 *   'stop'   → posts what is left, then { end: true }
 *   'cancel' → drops the take
 */

// Worklet globals; the DOM lib doesn't declare them.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

const OUT_RATE = 16000
const PREROLL = Math.round(OUT_RATE * 0.25)
const CHUNK = OUT_RATE / 10

class PcmCapture extends AudioWorkletProcessor {
  private ratio = sampleRate / OUT_RATE
  private phase = 0
  private acc = 0
  private n = 0
  private ring = new Float32Array(PREROLL)
  private ringAt = 0
  private ringFull = false
  private recording = false
  private chunk = new Float32Array(CHUNK)
  private chunkAt = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'start') {
        this.recording = true
        this.chunkAt = 0
        const pre = this.ringFull
          ? new Float32Array([...this.ring.subarray(this.ringAt), ...this.ring.subarray(0, this.ringAt)])
          : this.ring.slice(0, this.ringAt)
        this.ringAt = 0
        this.ringFull = false
        if (pre.length > 0) this.port.postMessage(pre, [pre.buffer])
      } else if (e.data === 'stop') {
        this.flush()
        this.recording = false
        this.port.postMessage({ end: true })
      } else if (e.data === 'cancel') {
        this.recording = false
        this.chunkAt = 0
      }
    }
  }

  private flush(): void {
    if (this.chunkAt === 0) return
    const out = this.chunk.slice(0, this.chunkAt)
    this.chunkAt = 0
    this.port.postMessage(out, [out.buffer])
  }

  private emit(v: number): void {
    if (this.recording) {
      this.chunk[this.chunkAt++] = v
      if (this.chunkAt === CHUNK) this.flush()
    } else {
      this.ring[this.ringAt++] = v
      if (this.ringAt === PREROLL) {
        this.ringAt = 0
        this.ringFull = true
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    if (!input) return true
    if (this.ratio === 1) {
      for (let i = 0; i < input.length; i++) this.emit(input[i])
      return true
    }
    // Box-filter decimation: average every input sample that falls inside one output
    // period. Crude, but it is a low-pass, so 48 kHz speech doesn't alias into the band
    // the recogniser listens to.
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]
      this.n++
      this.phase += 1
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        this.emit(this.acc / this.n)
        this.acc = 0
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
