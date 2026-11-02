/**
 * The dictation mic: an open stream feeding a 16 kHz PCM worklet and a level meter.
 *
 * It stays open between takes (the HUD closes it after an idle period), because
 * reopening the mic on every press clipped the first 100–500 ms of speech and put
 * getUserMedia plus AudioContext setup on the path of every take.
 */
import workletUrl from './pcmWorklet.ts?worker&url'
import { openMicStream } from './audio'

export class MicCapture {
  readonly stream: MediaStream
  readonly analyser: AnalyserNode
  /** The configured mic was gone, so this is the system default. */
  readonly fellBack: boolean
  /** The configured deviceId this was opened for ('' = default). */
  readonly deviceId: string
  private ctx: AudioContext
  private node: AudioWorkletNode
  private chunks: Float32Array[] = []
  private ended: (() => void) | null = null
  /** First audio of the current take has arrived. */
  private onFirst: (() => void) | null = null

  private constructor(
    stream: MediaStream,
    fellBack: boolean,
    deviceId: string,
    ctx: AudioContext,
    node: AudioWorkletNode,
    analyser: AnalyserNode
  ) {
    this.stream = stream
    this.fellBack = fellBack
    this.deviceId = deviceId
    this.ctx = ctx
    this.node = node
    this.analyser = analyser
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) {
        this.chunks.push(e.data)
        this.onFirst?.()
        this.onFirst = null
      } else if (e.data?.end) {
        this.ended?.()
        this.ended = null
      }
    }
  }

  static async open(deviceId: string): Promise<MicCapture> {
    const { stream, fellBack } = await openMicStream(deviceId)
    try {
      // Ask for 16 kHz so Chromium does a proper resample; the worklet copes with
      // any rate if the context can't honour it.
      let ctx: AudioContext
      try {
        ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
      } catch {
        ctx = new AudioContext({ latencyHint: 'interactive' })
      }
      await ctx.audioWorklet.addModule(workletUrl)
      const src = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
      const analyser = ctx.createAnalyser()
      // ~24 bars across the voice band at either rate.
      analyser.fftSize = ctx.sampleRate <= 16000 ? 128 : 256
      analyser.smoothingTimeConstant = 0.7
      src.connect(node)
      src.connect(analyser)
      if (ctx.state !== 'running') await ctx.resume()
      return new MicCapture(stream, fellBack, deviceId, ctx, node, analyser)
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw err
    }
  }

  get live(): boolean {
    return this.stream.getAudioTracks().some((t) => t.readyState === 'live') && this.ctx.state !== 'closed'
  }

  /** Begin a take (with the pre-roll). Resolves when the first audio arrives. */
  start(): Promise<void> {
    this.chunks = []
    const first = new Promise<void>((r) => (this.onFirst = r))
    this.node.port.postMessage('start')
    return first
  }

  /** End the take and return its samples. */
  async stop(): Promise<Float32Array> {
    const done = new Promise<void>((r) => (this.ended = r))
    this.node.port.postMessage('stop')
    // The worklet answers within one render quantum; never hang a take on it.
    await Promise.race([done, new Promise((r) => setTimeout(r, 500))])
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = new Float32Array(total)
    let at = 0
    for (const c of this.chunks) {
      out.set(c, at)
      at += c.length
    }
    this.chunks = []
    return out
  }

  cancel(): void {
    this.node.port.postMessage('cancel')
    this.chunks = []
  }

  close(): void {
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close().catch(() => {})
  }
}
