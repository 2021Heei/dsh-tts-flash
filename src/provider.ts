/**
 * TTS engine abstraction — the contract every speech backend must satisfy.
 *
 * Design goal (generic voice model): the plugin core only ever talks to this
 * interface. Adding a new engine (ChatTTS sidecar, GPT-SoVITS sidecar, ...)
 * is one new file under src/providers/ + a row in the auto-probe order; the
 * tap / segmenter / queue / SSE pipeline never changes.
 */

export interface VoiceInfo {
  id: string
  name: string
  /** true = voices hosted on this machine (offline capable). */
  local?: boolean
}

export interface SynthesizeOptions {
  /** Provider-specific voice id; empty = provider default. */
  voice?: string
  /** Rate offset in percent: -50 … 0 (normal) … +100. Provider best-effort. */
  rate?: number
  /** Volume offset in percent (0 = normal). Provider best-effort. */
  volume?: number
}

export interface TtsProvider {
  readonly id: string
  /** Short human label (shown in logs / settings later). */
  readonly label: string
  /** Provider can emit partial audio before the full sentence ends. */
  readonly streaming: boolean
  /** MIME of synthesize()'s returned bytes ('audio/mpeg', 'audio/wav', …). */
  readonly outputFormat: string

  /** Synthesize one full sentence → MP3 audio bytes. */
  synthesize(text: string, opts?: SynthesizeOptions): Promise<Buffer>

  /** Voices the provider exposes for the settings UI (best-effort). */
  listVoices(): Promise<VoiceInfo[]>

  // Optional remote-model lifecycle (sidecar engines only). The core treats
  // these as optional capabilities and never assumes their presence.

  /** Ask a remote engine to preload its model. True if a load started. */
  loadModel?(): Promise<boolean>
  /** Ask a remote engine to drop its model and free VRAM. True if it did. */
  unloadModel?(): Promise<boolean>
  /** Current remote-model state, or null when the engine cannot report one. */
  modelStatus?(): Promise<ModelStatus | null>
  /** "Host is alive" ping; silence lets the engine release its model. */
  heartbeat?(): Promise<void>
  /** UI protocol tag ('sidecar' | 'openai'), when the engine has one. */
  readonly apiStyle?: string
  /** Current user-message style/voice description (openai chat engines). */
  readonly stylePrompt?: string

  /**
   * Liveness probe.
   *  - in-process engines (edge-tts): resolves once the connection works.
   *  - sidecar engines (ChatTTS/GPT-SoVITS): HTTP ping with short timeout.
   */
  isAvailable(): Promise<boolean>

  /** Release connections / close child resources. */
  dispose(): Promise<void>
}

export interface ModelStatus {
  loaded: boolean
  loading: boolean
  device: string
  error: string | null
  idleSeconds: number | null
}

/** Pick the first provider whose isAvailable() resolves true. */
export async function pickFirstAvailable(
  candidates: TtsProvider[],
): Promise<TtsProvider> {
  for (const p of candidates) {
    try {
      if (await p.isAvailable()) return p
    } catch {
      // probe error → try next
    }
  }
  return candidates[candidates.length - 1] ?? ((): never => {
    throw new Error('no TTS provider registered')
  })()
}
