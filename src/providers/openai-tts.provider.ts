/**
 * TTS provider for cloud vendors that speak the OpenAI `/audio/speech`
 * protocol (OpenAI, 小米 MiMo 开放平台,硅基流动, etc.).
 *
 * Registered at runtime via the settings panel → POST /engines → an engine
 * declaration file with kind:'openai' in ~/.dsh/tts-flash/engines/.
 */

import type { SynthesizeOptions, TtsProvider, VoiceInfo } from '../provider.ts'

export interface OpenAiTtsConfig {
  /** Stable id (the declaration file's id). */
  id: string
  /** Human label shown in the UI (= the user's 别名). */
  label: string
  /** Base URL *including* the version path, e.g. https://api.openai.com/v1 */
  baseUrl: string
  apiKey: string
  /** The vendor's model id — sent verbatim as the `model` parameter. */
  model: string
  /** Optional default voice id (vendor-specific). */
  voice?: string
  /** Optional user-message content: style instruction / voice description. */
  stylePrompt?: string
}

/** OpenAI's standard voice ids; vendors that ignore `voice` just ignore it. */
const KNOWN_VOICES: VoiceInfo[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map(
  (id) => ({ id, name: id }),
)

/** HTTP error carrying the status so callers can react (e.g. 404 fallback). */
class SpeechHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`openai-tts HTTP ${status}: ${body}`)
  }
}

/** Map the rate slider (-75…+200 %) to a natural-language pace instruction
 *  the TTS model can follow (these models have no numeric speed parameter). */
function rateInstruction(rate: number): string {
  if (!rate) return ''
  const clamped = Math.min(200, Math.max(-75, Math.round(rate)))
  if (clamped === 0) return ''
  const factor = 1 + clamped / 100
  return clamped > 0
    ? `语速要求：以正常语速的 ${factor.toFixed(1)} 倍朗读，节奏轻快但咬字清晰自然。`
    : `语速要求：以正常语速的 ${factor.toFixed(2)} 倍放慢朗读，保持自然流畅。`
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly id: string
  readonly label: string
  readonly streaming = false
  readonly outputFormat = 'audio/mpeg'
  readonly apiStyle = 'openai'

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly defaultVoice: string
  readonly stylePrompt: string
  /** Set after a 404 on /audio/speech: the vendor speaks MiMo chat-style TTS. */
  private chatStyle = false

  constructor(cfg: OpenAiTtsConfig) {
    this.id = cfg.id
    this.label = cfg.label
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.model = cfg.model
    this.defaultVoice = cfg.voice || ''
    this.stylePrompt = cfg.stylePrompt || ''
  }

  async synthesize(text: string, opts?: SynthesizeOptions): Promise<Buffer> {
    const voice = opts?.voice || this.defaultVoice
    const rate = opts?.rate ?? 0
    if (!this.chatStyle) {
      try {
        return await this.speechRequest(text, voice)
      } catch (e) {
        // 404 = the vendor has no /audio/speech endpoint (e.g. 小米 MiMo);
        // fall back to the chat/completions protocol and remember it.
        if (e instanceof SpeechHttpError && e.status === 404) {
          this.chatStyle = true
        } else {
          throw e
        }
      }
    }
    return this.chatRequest(text, voice, rate)
  }

  /** OpenAI standard: POST /audio/speech → raw audio bytes. */
  private async speechRequest(text: string, voice: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: voice || 'alloy',
        response_format: 'mp3',
      }),
      // A hung vendor must not hold the playback queue forever.
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new SpeechHttpError(res.status, (await res.text()).slice(0, 200))
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) throw new Error('openai-tts returned empty audio')
    return buf
  }

  /** Build the chat messages: optional user style/voice-description (+ a
   *  natural-language pace instruction when the rate slider is off 0) and the
   *  target text in the assistant slot. */
  private chatMessages(
    text: string,
    voice: string,
    rate = 0,
  ): Array<{ role: string; content: string }> {
    const voiceDescribed = /voicedesign|voiceclone/i.test(this.model)
    const styleBase = this.stylePrompt ||
      (voiceDescribed
        ? 'A pleasant, natural-sounding voice: warm, clear articulation, moderate pace.'
        : '')
    const userContent = [styleBase, rateInstruction(rate)].filter(Boolean).join(' ')
    const messages: Array<{ role: string; content: string }> = []
    if (userContent) messages.push({ role: 'user', content: userContent })
    messages.push({ role: 'assistant', content: text })
    return messages
  }

  /** voicedesign/voiceclone models reject preset voices — omit `voice`. */
  private chatAudioExtra(voice: string): Record<string, string> {
    const voiceDescribed = /voicedesign|voiceclone/i.test(this.model)
    return voice && !voiceDescribed ? { voice } : {}
  }

  /**
   * MiMo style: POST /chat/completions with the target text in an `assistant`
   * message, optional style/voice-description (+ pace instruction) in a
   * `user` message, and `audio: { voice?, format }`. Audio comes back as
   * base64 in `choices[0].message.audio.data`.
   */
  private async chatRequest(text: string, voice: string, rate = 0): Promise<Buffer> {
    const audio: Record<string, string> = { format: 'mp3', ...this.chatAudioExtra(voice) }
    const messages = this.chatMessages(text, voice, rate)
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        modalities: ['text', 'audio'],
        audio,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new SpeechHttpError(res.status, (await res.text()).slice(0, 200))
    const json = (await res.json()) as {
      choices?: Array<{ message?: { audio?: { data?: string } } }>
    }
    const data = json.choices?.[0]?.message?.audio?.data
    if (!data) throw new Error('openai-tts chat response contained no audio data')
    const buf = Buffer.from(data, 'base64')
    if (buf.length === 0) throw new Error('openai-tts returned empty audio')
    return buf
  }

  async listVoices(): Promise<VoiceInfo[]> {
    // Vendor-specific: MiMo exposes preset voices on its tts model; design /
    // clone models derive the voice from the user message instead.
    if (/voicedesign|voiceclone/i.test(this.model)) {
      return [{ id: '', name: '音色由描述/样本决定' }]
    }
    if (/mimo/i.test(this.model) || this.chatStyle) {
      return ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'].map(
        (id) => ({ id, name: id }),
      )
    }
    return KNOWN_VOICES.map((v) => ({ ...v }))
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3000),
      })
      return res.status !== 401 && res.status !== 403
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }
}
