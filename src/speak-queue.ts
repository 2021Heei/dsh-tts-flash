/**
 * Per-session speak queue: serial synthesis through the active TtsProvider +
 * SSE broadcast of MP3 frames.
 *
 * The llm/stream tap is lossless and synchronous-fast: it only segments
 * deltas and enqueues sentences. Synthesis runs on a background pump so the
 * model stream is never blocked by network/audio work.
 *
 * Barge-in / stop: `cancel()` bumps the session epoch, which drops queued
 * sentences AND discards the in-flight synthesis result, so an interrupt
 * truly silences the assistant instead of letting the current sentence leak.
 *
 * Adapted from @haoku123/dsh-voice (MIT): src/tts-queue.ts — the difference
 * is that synthesis goes through the TtsProvider abstraction instead of a
 * hardcoded MsEdgeTTS instance.
 */

import type { TtsProvider, SynthesizeOptions } from './provider.ts'

export interface VoiceFrame {
  sessionId: string
  seq: number
  /** Markdown-stripped sentence text (shown as live caption). */
  text: string
  /** Base64 audio bytes (provider-dependent sample rate / codec). */
  audio: string
  /** MIME of the decoded bytes, e.g. audio/mpeg or audio/wav. */
  mime: string
}

export type FrameListener = (frame: VoiceFrame) => void

interface QueuedSentence {
  text: string
  epoch: number
  /** Pre-synthesized audio (disk-cached thinking phrases): pump skips TTS. */
  audio?: Buffer
  /** MIME for pre-synthesized audio; defaults to the provider's format. */
  mime?: string
}

interface SessionQueue {
  pending: QueuedSentence[]
  busy: boolean
  seq: number
  /** Bumped by cancel(); sentences carrying a stale epoch are dropped. */
  epoch: number
}

export interface SpeakQueueOptions {
  /** Called lazily at pump time so an async engine pick can swap in. */
  resolveProvider: () => TtsProvider
  /** Provider-level default voice id ('' = provider default). */
  voice?: string
  /** Rate offset in percent: -50 … 0 (normal) … +100. */
  rate?: number
  /** Playback volume multiplier (1 = normal); only >1 reaches synthesis. */
  volume?: number
  /** Called whenever a TEXT sentence is enqueued (pre-synthesized waiting
   *  phrases excluded) — the waiting-phrase loop listens on this to stop the
   *  moment the reply's own speech begins. */
  onTextEnqueue?: (sessionId: string) => void
}

/** Max queued sentences per session before the oldest is dropped. */
const MAX_PENDING = 12

export class SpeakQueue {
  private readonly queues = new Map<string, SessionQueue>()
  private readonly listeners = new Set<FrameListener>()
  private readonly opts: SpeakQueueOptions

  constructor(opts: SpeakQueueOptions) {
    this.opts = opts
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Enqueue one sentence for a session; starts the pump if idle. */
  enqueue(sessionId: string, text: string): void {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0 }
      this.queues.set(sessionId, q)
    }
    // Back-pressure: cap the per-session queue so a very long reply cannot
    // pile up unbounded; the oldest sentence is dropped and playback chases
    // the live output.
    while (q.pending.length >= MAX_PENDING) q.pending.shift()
    q.pending.push({ text, epoch: q.epoch })
    this.opts.onTextEnqueue?.(sessionId)
    void this.pump(sessionId, q)
  }

  /** Enqueue one PRE-SYNTHESIZED sentence (thinking phrase from disk cache):
   *  the pump broadcasts it as-is without calling the TTS engine. */
  enqueueAudio(sessionId: string, text: string, audio: Buffer, mime: string): void {
    let q = this.queues.get(sessionId)
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0 }
      this.queues.set(sessionId, q)
    }
    while (q.pending.length >= MAX_PENDING) q.pending.shift()
    q.pending.push({ text, epoch: q.epoch, audio, mime })
    void this.pump(sessionId, q)
  }

  /** True when the session has nothing queued and no synthesis in flight. */
  isIdle(sessionId: string): boolean {
    const q = this.queues.get(sessionId)
    return !q || (q.pending.length === 0 && !q.busy)
  }

  /**
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (stop / barge-in). Sentences enqueued after this call get
   * the new epoch and play normally.
   */
  cancel(sessionId: string): void {
    const q = this.queues.get(sessionId)
    if (q) {
      q.epoch++
      q.pending.length = 0
    }
  }

  cancelAll(): void {
    for (const sessionId of this.queues.keys()) this.cancel(sessionId)
  }

  /** Apply a settings change (voice / rate) to sentences synthesized later. */
  configure(patch: { voice?: string; rate?: number; volume?: number }): void {
    if (patch.voice !== undefined) this.opts.voice = patch.voice
    if (patch.rate !== undefined) this.opts.rate = patch.rate
    if (patch.volume !== undefined) this.opts.volume = patch.volume
  }

  private synthOptions(voice?: string): SynthesizeOptions {
    const opts: SynthesizeOptions = {}
    if (voice) opts.voice = voice
    // rate is a percent offset where 0 means "provider default" — only pass it
    // when the user actually moved the slider.
    if (this.opts.rate) opts.rate = this.opts.rate
    // <=100 % is handled at playback (audio.volume); only the gain part above
    // 100 % needs synthesis-side amplification.
    if (this.opts.volume && this.opts.volume > 1) opts.volume = this.opts.volume
    return opts
  }

  private async pump(sessionId: string, q: SessionQueue): Promise<void> {
    if (q.busy) return
    q.busy = true
    try {
      const provider = this.opts.resolveProvider()
      while (q.pending.length > 0) {
        const item = q.pending.shift()!
        try {
          const buf =
            item.audio ?? (await provider.synthesize(item.text, this.synthOptions(this.opts.voice)))
          // Barge-in happened while this sentence was synthesizing: drop it.
          if (item.epoch !== q.epoch) continue
          const frame: VoiceFrame = {
            sessionId,
            seq: q.seq++,
            text: item.text,
            audio: buf.toString('base64'),
            mime: item.mime ?? provider.outputFormat,
          }
          for (const fn of this.listeners) {
            try {
              fn(frame)
            } catch {
              // listener errors must not kill the pump
            }
          }
        } catch (e) {
          // One failed sentence must not stop the queue; report and continue.
          console.warn(`[tts-flash] synthesis failed: ${String(e)}`)
        }
      }
    } catch (e) {
      console.warn(`[tts-flash] TTS unavailable: ${String(e)}`)
    } finally {
      q.busy = false
      if (q.pending.length > 0) void this.pump(sessionId, q)
    }
  }
}
