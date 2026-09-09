/**
 * edge-tts provider — in-process, zero-config default engine.
 * Uses the free Microsoft Edge neural voices (cloud). Guaranteed available,
 * so it is the graceful fallback whenever a local sidecar is missing/down.
 */

// msedge-tts is CommonJS. A plain named ESM import is not guaranteed to resolve
// under Node's CJS named-export detection, so take the default (= module.exports)
// and unwrap it defensively (handles both `exports.X` and `exports.default.X`).
import msedgeTtsModule from 'msedge-tts'
import type { TtsProvider, VoiceInfo, SynthesizeOptions } from '../provider.ts'

type EdgeTtsInstance = {
  setMetadata(voice: string, format: string, metadataOptions?: Record<string, unknown>): Promise<void>
  toStream(
    input: string,
    options?: Record<string, unknown>,
  ): { audioStream: AsyncIterable<Buffer> | Iterable<Buffer>; metadataStream?: unknown }
  getVoices(): Promise<EdgeVoice[]>
  close(): Promise<void> | void
}

interface EdgeVoice {
  ShortName?: string
  FriendlyName?: string
  Locale?: string
  Gender?: string
}

const msedge = msedgeTtsModule as unknown as {
  MsEdgeTTS?: new () => EdgeTtsInstance
  OUTPUT_FORMAT?: Record<string, string>
  default?: { MsEdgeTTS?: new () => EdgeTtsInstance; OUTPUT_FORMAT?: Record<string, string> }
}

const MsEdgeTTS = msedge.MsEdgeTTS ?? msedge.default?.MsEdgeTTS
const OUTPUT_FORMAT: Record<string, string> = msedge.OUTPUT_FORMAT ?? msedge.default?.OUTPUT_FORMAT ?? {}

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
/** Voice list cache TTL (the Edge list is big and rarely changes). */
const VOICE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Settings carry rate as a percent offset (-75…+200, 0 = normal); Edge wants
 * either an enum word or a signed percentage string like "+20%".
 */
function toEdgeRate(rate: number | undefined): string | undefined {
  if (rate === undefined || !Number.isFinite(rate) || rate === 0) return undefined
  const pct = Math.min(200, Math.max(-75, Math.round(rate)))
  return `${pct > 0 ? '+' : ''}${pct}%`
}

const ZH_VOICES: VoiceInfo[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女·自然）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男·自然）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男·少年）' },
  { id: 'zh-CN-YunyangNeural', name: '云扬（男·新闻）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北女声）' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台湾女声）' },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳（香港女声）' },
]

export class EdgeTtsProvider implements TtsProvider {
  readonly id = 'edge-tts'
  readonly label = 'Edge TTS（微软云 · 零配置兜底）'
  readonly streaming = false
  readonly outputFormat = 'audio/mpeg'

  private tts: EdgeTtsInstance | null = null
  private ready: Promise<void> | null = null
  private voices: VoiceInfo[] | null = null
  private voicesAt = 0
  private currentVoice = DEFAULT_VOICE

  constructor(
    private readonly options: {
      voice?: string
      /** Rate offset in percent (-50…+100, 0 = normal). */
      ratePercent?: number
      /** Playback volume in percent (100 = normal); >100 amplifies via SSML. */
      volumePercent?: number
      prosody?: Record<string, unknown>
    } = {},
  ) {
    if (options.voice) this.currentVoice = options.voice
  }

  private ensureReady(voice: string): Promise<void> {
    if (voice !== this.currentVoice || !this.ready) {
      this.ready = null
      if (!MsEdgeTTS) throw new Error('msedge-tts is unavailable (MsEdgeTTS export missing)')
      const tts = new MsEdgeTTS()
      this.tts = tts
      this.currentVoice = voice
      this.ready = tts
        .setMetadata(
          voice,
          OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 ?? 'audio-24khz-48kbitrate-mono-mp3',
          {
            wordBoundaryEnabled: false,
            sentenceBoundaryEnabled: false,
          },
        )
        .catch((e) => {
          this.ready = null
          this.tts = null
          throw e
        })
    }
    return this.ready
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureReady(this.currentVoice)
      return true
    } catch {
      return false
    }
  }

  /**
   * Live list from Microsoft (hundreds of voices), cached because the settings
   * panel asks on every open. Falls back to the built-in Chinese shortlist when
   * the network is unavailable so the dropdown is never empty.
   */
  async listVoices(): Promise<VoiceInfo[]> {
    if (this.voices && Date.now() - this.voicesAt < VOICE_TTL_MS) return this.voices
    if (!MsEdgeTTS) return ZH_VOICES
    try {
      const tts = new MsEdgeTTS()
      const raw = await tts.getVoices()
      const list: VoiceInfo[] = (raw ?? [])
        .filter((v) => typeof v?.ShortName === 'string')
        .map((v) => ({
          id: v.ShortName!,
          name: `${v.FriendlyName ?? v.ShortName}（${v.Locale ?? '?'}）`,
        }))
      if (list.length === 0) return ZH_VOICES
      // Chinese first (this is a Chinese-language plugin), then everything else.
      list.sort((a, b) => {
        const az = /^zh/i.test(a.id) ? 0 : 1
        const bz = /^zh/i.test(b.id) ? 0 : 1
        return az - bz || a.id.localeCompare(b.id)
      })
      this.voices = list
      this.voicesAt = Date.now()
      return list
    } catch {
      return ZH_VOICES
    }
  }

  async synthesize(text: string, opts?: SynthesizeOptions): Promise<Buffer> {
    const voice = opts?.voice || this.options.voice || DEFAULT_VOICE
    await this.ensureReady(voice)
    if (!this.tts) throw new Error('edge-tts not initialized')
    const rate = toEdgeRate(opts?.rate ?? this.options.ratePercent)
    // <=100 % is attenuated at playback; synthesis only amplifies the part
    // above 100 % (SSML prosody volume, relative percentage).
    const volPct = opts?.volume ? 100 + Math.round((opts.volume - 1) * 100) : (this.options.volumePercent ?? 100)
    const volume = volPct > 100 ? `+${volPct - 100}%` : undefined
    const prosody = {
      ...(rate ? { rate } : {}),
      ...(volume ? { volume } : {}),
    }
    const { audioStream } = await this.tts.toStream(text, Object.keys(prosody).length ? prosody : undefined)
    const chunks: Buffer[] = []
    for await (const chunk of audioStream) {
      chunks.push(chunk as Buffer)
    }
    const buf = Buffer.concat(chunks)
    if (buf.length === 0) throw new Error('edge-tts returned empty audio')
    return buf
  }

  async dispose(): Promise<void> {
    this.ready = null
    if (this.tts) {
      const t = this.tts
      this.tts = null
      // close() is synchronous in msedge-tts; keep it failure-proof either way.
      await Promise.resolve(t.close()).catch(() => undefined)
    }
  }
}
