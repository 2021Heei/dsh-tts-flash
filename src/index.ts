/**
 * dsh-voice-reader — host half.
 *
 * A generic "read the LLM reply aloud" engine for DeepSeek Harness.
 *
 * Pipeline:
 *   llm/stream (lossless tap)
 *     → SentenceSegmenter (per session)
 *     → SpeakQueue (serial, epoch-cancellable)
 *     → SSE `event: audio` frames at {basePath}/stream
 *     → browser <audio> playback (see src/client.tsx)
 *
 * TTS engines are swappable behind the TtsProvider interface (src/provider.ts).
 * Built-in: edge-tts (in-process). Sidecar: ChatTTS / GPT-SoVITS (M2+).
 *
 * HTTP surface (all under config.basePath, default /dsh-voice-reader):
 *   GET  /stream      SSE audio frames
 *   POST /cancel      { sessionId } → epoch-bump that session
 *   GET  /config      settings + engine list (with availability) + voices
 *   POST /config      persist a settings patch { enabled?, engine?, voice?, rate? }
 *   POST /preview     { text, engine?, voice?, rate? } → { audio: base64 mp3 }
 *   POST /test-speak  { text, sessionId? } dev-only self-test (config.devTest)
 *   GET  (prefix)     health ping
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SentenceSegmenter, plainText } from './segmenter.ts'
import { THINK_PHRASES } from './thinking-phrases.ts'
import { SpeakQueue, type VoiceFrame } from './speak-queue.ts'
import { EdgeTtsProvider } from './providers/edge-tts.provider.ts'
import { OpenAiTtsProvider } from './providers/openai-tts.provider.ts'
import { pickFirstAvailable, type SynthesizeOptions, type TtsProvider, type VoiceInfo } from './provider.ts'
import {
  DATA_DIR,
  hasSettingsFile,
  loadEngineDeclarations,
  loadSettings,
  saveEngineDeclaration,
  saveSettings,
  type VoiceSettings,
} from './settings-store.ts'

export const name = 'voice-reader'
export const inject = ['webServer']

export interface Config {
  /** Master switch (seed value; the settings panel owns it afterwards). */
  enabled: boolean
  /** URL prefix for every HTTP route this plugin owns. */
  basePath: string
  /** 'auto' | 'edge-tts' | any id declared in engines/. */
  engine: string
  /** Voice id passed to whichever engine is active ('' = engine default). */
  voice: string
  /** Rate offset in percent: -75 … 0 (normal) … +200. */
  rate: number
  /** Playback volume in percent (seed value): 0 … 100 … 200. */
  volume: number
  /** Caption font size in px (seed value): 10 … 30. */
  fontSize: number
  /** Caption gradient colors + shimmer speed (seed values). */
  captionColor1: string
  captionColor2: string
  shimmerSec: number
  /** Enable POST /test-speak for end-to-end debugging. */
  devTest: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default('/dsh-voice-reader'),
  engine: z.string().default('auto'),
  voice: z.string().default(''),
  rate: z.number().default(0),
  volume: z.number().default(100),
  fontSize: z.number().default(16),
  captionColor1: z.string().default('#5b8cff'),
  captionColor2: z.string().default('#a78bfa'),
  shimmerSec: z.number().default(4),
  devTest: z.boolean().default(false),
})

/** Structural view of the chunk objects flowing through llm/stream. */
interface StreamChunk {
  type: string
  text?: string
  reason?: unknown
}

interface GenerateOptions {
  sessionId?: string
}

// ---- short-sentence coalescing before synthesis ---------------------------
// "好。" / "明白。" each triggering a full engine request is slow and choppy
// on local engines. Strong terminal punctuation releases the buffer once it
// holds a readable amount (>= STRONG_MIN); weak endings accumulate to
// SOFT_LIMIT; anything reaches HARD_LIMIT. Stream end always flushes.
const STRONG_END = /[。！？!?…；;]$/
const HARD_LIMIT = 60
const STRONG_MIN = 12
const SOFT_LIMIT = 40

class SentenceGrouper {
  private buf = ''
  push(sentence: string): string[] {
    this.buf += sentence
    if (this.buf.length >= HARD_LIMIT) return this.take()
    if (this.buf.length >= STRONG_MIN && STRONG_END.test(this.buf)) return this.take()
    if (this.buf.length >= SOFT_LIMIT) return this.take()
    return []
  }
  flush(): string[] {
    return this.take()
  }
  private take(): string[] {
    const out = this.buf ? [this.buf] : []
    this.buf = ''
    return out
  }
}

export function apply(ctx: Context, config: Config): void {
  const base = config.basePath

  // ---- settings: persisted file, seeded from the plugin config on first run ----
  if (!hasSettingsFile()) {
    saveSettings({
      enabled: config.enabled,
      engine: config.engine,
      voice: config.voice,
      rate: config.rate,
      volume: config.volume,
      fontSize: config.fontSize,
      captionColor1: config.captionColor1,
      captionColor2: config.captionColor2,
      shimmerSec: config.shimmerSec,
    })
  }
  let settings: VoiceSettings = loadSettings()

  // ---- engine registry: built-ins + drop-in declarations from engines/ ----
  let providers: TtsProvider[] = []

  const buildProviders = (): TtsProvider[] => {
    const voice = settings.voice || undefined
    const list: TtsProvider[] = [
      new EdgeTtsProvider({ voice, ratePercent: settings.rate, volumePercent: settings.volume }),
    ]
    // New models appear here without a rebuild: drop a JSON declaration into
    // ~/.dsh/voice-reader/engines/ and it shows up in the settings dropdown.
    for (const decl of loadEngineDeclarations()) {
      if (list.some((p) => p.id === decl.id)) continue
      if (decl.kind === 'openai') {
        if (!decl.apiKey || !decl.model) continue // malformed declaration
        list.push(
          new OpenAiTtsProvider({
            id: decl.id,
            label: decl.label,
            baseUrl: decl.url,
            apiKey: decl.apiKey,
            model: decl.model,
            voice: decl.voice,
            stylePrompt: decl.stylePrompt,
          }),
        )
      }
    }
    return list
  }

  const findProvider = (id: string): TtsProvider | undefined => providers.find((p) => p.id === id)
  const fallback = (): TtsProvider => findProvider('edge-tts') ?? providers[0]

  let engine: TtsProvider
  let picked: Promise<TtsProvider>

  const resolveEngine = (): Promise<TtsProvider> => {
    const requested = settings.engine
    if (requested && requested !== 'auto') {
      const target = findProvider(requested)
      return (async () => {
        if (target && (await target.isAvailable().catch(() => false))) return target
        if (target) {
          console.warn(`[voice-reader] engine "${requested}" 不可用，回退 edge-tts`)
        }
        return fallback()
      })()
    }
    // auto: local sidecars first (offline capable), edge-tts as the last resort.
    const locals = providers.filter((p) => p.id !== 'edge-tts')
    const order = [...locals, ...providers.filter((p) => p.id === 'edge-tts')]
    return pickFirstAvailable(order)
  }

  /** Rebuild the registry + re-resolve the active engine (after a settings change). */
  const refreshEngine = (): void => {
    const old = providers
    providers = buildProviders()
    // Release the replaced instances so their sockets do not leak (edge-tts
    // keeps a WebSocket). Delayed so an in-flight synthesis on the old
    // instance gets a grace period to finish.
    for (const p of old) {
      setTimeout(() => void p.dispose().catch(() => undefined), 5000)
    }
    picked = resolveEngine().then((p) => {
      engine = p
      return p
    })
  }

  providers = buildProviders()
  engine = fallback()
  refreshEngine()

  // ---- queue: provider resolved lazily at pump time ----
  const queue = new SpeakQueue({
    resolveProvider: () => engine,
    voice: settings.voice,
    rate: settings.rate,
    volume: settings.volume,
    // The first REAL sentence enqueued ends the waiting-phrase loop
    // immediately (stopThinkingLoop is declared below; the indirection is
    // resolved at call time, long after apply() has finished).
    onTextEnqueue: (sessionId) => stopThinkingLoop(sessionId),
  })

  // ---- waiting (thinking) phrases: named audio files per model ----
  // While the model chews, the voice bar rotates text phrases AND speaks one
  // at the start of the wait. Audio files live in
  //   ~/.dsh/voice-reader/cache/thinking/<engine>-<voice>.p<index>.<ext>
  // — the index maps 1:1 to THINK_PHRASES, the prefix carries the model (and
  // voice) so several models can coexist. Files are produced by the 「批量生成
  // 等待语音」 button, or auto-generated on the first conversation that needs
  // them (default: edge-tts + Microsoft Xiaoyi zh-CN).
  const THINK_CACHE_DIR = join(DATA_DIR, 'cache', 'thinking')
  // "Microsoft Xiaoyi Online (Natural) - Chinese (Mainland) (zh-CN)".
  const THINK_DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

  const mimeExt = (mime: string): string => (mime.includes('wav') ? 'wav' : 'mp3')
  const extMime = (ext: string): string => (ext === 'wav' ? 'audio/wav' : 'audio/mpeg')

  /** Resolve the waiting-voice engine + voice from the settings dropdown.
   *  Unspecified ('' / 'auto' / unknown id) → edge-tts with Xiaoyi. */
  const resolveThinking = (): { provider: TtsProvider; voice: string } => {
    const id = settings.thinkingEngine
    const edge = providers.find((p) => p.id === 'edge-tts')
    if (!id || id === 'auto') {
      return edge
        ? { provider: edge, voice: THINK_DEFAULT_VOICE }
        : { provider: engine, voice: settings.voice || '' }
    }
    const p = providers.find((x) => x.id === id)
    if (!p) {
      return edge
        ? { provider: edge, voice: THINK_DEFAULT_VOICE }
        : { provider: engine, voice: settings.voice || '' }
    }
    // openai-style engines bake their declaration voice in as the default —
    // pass '' so that default applies. Everything else follows the main voice.
    if ((p as { apiStyle?: string }).apiStyle === 'openai') return { provider: p, voice: '' }
    return { provider: p, voice: settings.voice || '' }
  }

  /** `<engine>-<voice>` filename prefix, sanitized for the filesystem. */
  const thinkingPrefix = (provider: TtsProvider, voice: string): string =>
    `${provider.id}-${voice || 'default'}`.replace(/[^\w.-]+/g, '_')

  /** Locate one cached phrase file (either extension); null when missing. */
  const findCached = (
    prefix: string,
    i: number,
  ): { path: string; mime: string } | null => {
    for (const ext of ['mp3', 'wav']) {
      const path = join(THINK_CACHE_DIR, `${prefix}.p${i}.${ext}`)
      try {
        if (existsSync(path)) return { path, mime: extMime(ext) }
      } catch {
        // unreadable disk → treat as missing
      }
    }
    return null
  }

  /** Generate every missing phrase file for the resolved waiting engine.
   *  Existing files are kept; concurrent calls share one in-flight run. */
  let ensureInFlight: Promise<{ prefix: string; generated: number; total: number }> | null = null
  const ensureThinkingAudio = (): Promise<{ prefix: string; generated: number; total: number }> => {
    if (ensureInFlight) return ensureInFlight
    ensureInFlight = (async () => {
      const { provider, voice } = resolveThinking()
      const prefix = thinkingPrefix(provider, voice)
      try {
        mkdirSync(THINK_CACHE_DIR, { recursive: true })
      } catch {
        // read-only disk → nothing will persist, still try to speak
      }
      let generated = 0
      for (let i = 0; i < THINK_PHRASES.length; i++) {
        if (!findCached(prefix, i)) {
          try {
            const opts: SynthesizeOptions = voice ? { voice } : {}
            const buf = await provider.synthesize(THINK_PHRASES[i], opts)
            if (buf && buf.length > 0) {
              try {
                writeFileSync(
                  join(THINK_CACHE_DIR, `${prefix}.p${i}.${mimeExt(provider.outputFormat)}`),
                  buf,
                )
              } catch {
                // cache write failed → next run re-synthesizes, not fatal
              }
              generated++
            }
          } catch {
            // one failed phrase must not abort the batch
          }
          // Gentle pacing for cloud quotas.
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
      return { prefix, generated, total: THINK_PHRASES.length }
    })().finally(() => {
      ensureInFlight = null
    })
    return ensureInFlight
  }

  // ---- waiting-phrase loop: drives BOTH the bar text and the voice ----
  // Every switch broadcasts the new phrase text over SSE (the bar shows
  // exactly what is being said) and plays the matching cached audio file, so
  // the whole waiting period is voiced, not just its start. The loop stops
  // itself the moment the reply's own speech takes the queue, and is torn
  // down when the generation ends.
  const THINK_FIRST_DELAY_MS = 700 // let the user settle after hitting send
  const THINK_SWITCH_BASE_MS = 2600 // phrase switch interval (fixed part)
  const THINK_SWITCH_JITTER_MS = 900 // + random jitter → never rhythmical
  const thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const stopThinkingLoop = (sessionId: string): void => {
    const t = thinkingTimers.get(sessionId)
    if (t) clearTimeout(t)
    thinkingTimers.delete(sessionId)
  }
  const startThinkingLoop = (sessionId: string): void => {
    stopThinkingLoop(sessionId)
    let lastPick = -1
    const tick = (): void => {
      // The reply's own speech has begun → the wait is over, stop interleaving.
      if (!queue.isIdle(sessionId)) {
        thinkingTimers.delete(sessionId)
        return
      }
      const { provider, voice } = resolveThinking()
      const prefix = thinkingPrefix(provider, voice)
      let idx = (Math.random() * THINK_PHRASES.length) | 0
      if (THINK_PHRASES.length > 1) {
        while (idx === lastPick) idx = (Math.random() * THINK_PHRASES.length) | 0
      }
      lastPick = idx
      // Text and voice together: the bar shows exactly what is being said.
      broadcast('status', { phase: 'thinking', text: THINK_PHRASES[idx] })
      const hit = findCached(prefix, idx)
      if (hit) {
        try {
          queue.enqueueAudio(sessionId, THINK_PHRASES[idx], readFileSync(hit.path), hit.mime)
        } catch {
          // unreadable file → text-only tick
        }
      } else {
        // File missing → bake the full set for this engine in the background;
        // this tick stays text-only.
        void ensureThinkingAudio().catch(() => undefined)
      }
      thinkingTimers.set(
        sessionId,
        setTimeout(tick, THINK_SWITCH_BASE_MS + Math.random() * THINK_SWITCH_JITTER_MS),
      )
    }
    thinkingTimers.set(sessionId, setTimeout(tick, THINK_FIRST_DELAY_MS))
  }

  // ---- snapshot shared by GET/POST /config ----
  interface EngineInfo {
    id: string
    label: string
    streaming: boolean
    available: boolean
  }

  let enginesCache: { at: number; list: EngineInfo[] } | null = null

  const listEngines = async (): Promise<EngineInfo[]> => {
    // Probing hits the network / a sidecar, so cache briefly — the settings
    // panel asks on every open and on every change.
    if (enginesCache && Date.now() - enginesCache.at < 3000) return enginesCache.list
    const list = await Promise.all(
      providers.map(async (p) => ({
        id: p.id,
        label: p.label,
        streaming: p.streaming,
        available: await p.isAvailable().catch(() => false),
        apiStyle: (p as { apiStyle?: string }).apiStyle,
        stylePrompt: (p as { stylePrompt?: string }).stylePrompt,
      })),
    )
    enginesCache = { at: Date.now(), list }
    return list
  }

  const snapshot = async (): Promise<Record<string, unknown>> => {
    const active = await picked.catch(() => engine)
    let voices: VoiceInfo[] = []
    try {
      voices = await active.listVoices()
    } catch {
      voices = []
    }
    return {
      enabled: settings.enabled,
      engine: active.id,
      engineRequested: settings.engine,
      voice: settings.voice,
      rate: settings.rate,
      volume: settings.volume,
      fontSize: settings.fontSize,
      captionColor1: settings.captionColor1,
      captionColor2: settings.captionColor2,
      shimmerSec: settings.shimmerSec,
      thinkingEngine: settings.thinkingEngine,
      basePath: base,
      devTest: config.devTest,
      engines: await listEngines(),
      voices,
    }
  }

  const readJsonBody = (req: unknown, done: (body: Record<string, unknown>) => void): void => {
    const chunks: Buffer[] = []
    const r = req as {
      on: (e: string, fn: ((c: Buffer) => void) | (() => void)) => void
    }
    r.on('data', (c: Buffer) => chunks.push(c))
    r.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as unknown
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
      } catch {
        // malformed body → treat as empty patch
      }
      // A handler bug here is a synchronous throw inside a stream 'end'
      // handler — that crashes the whole host process. Contain it.
      try {
        done(body)
      } catch (e) {
        console.error('[voice-reader] route handler failed:', e)
        try {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'internal error' }))
        } catch {
          // response may already be gone
        }
      }
    })
  }

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    // The renderer must never reuse a stale snapshot: engines/voices change
    // as sidecars come and go.
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  // ---- SSE fan-out ----
  type SseSend = (event: string, data: unknown) => void
  const clients = new Set<SseSend>()
  const broadcast = (event: string, data: unknown): void => {
    for (const send of clients) {
      try {
        send(event, data)
      } catch {
        // dead socket: its close handler removes it
      }
    }
  }
  const unsub = queue.subscribe((frame) => {
    broadcast('audio', frame)
  })
  ctx.effect(() => unsub)

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/stream`,
      handler: (req: unknown, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        // Tell the browser to back off between reconnects (and keep proxies
        // from buffering the stream).
        res.write('retry: 3000\n\n')
        const send = (event: string, data: unknown): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        clients.add(send)
        const heartbeat = setInterval(() => {
          res.write(': hb\n')
        }, 25000)
        const cleanup = (): void => {
          clearInterval(heartbeat)
          clients.delete(send)
        }
        // `req` is a Node IncomingMessage; guard the optional chaining so a
        // non-standard request object cannot break the route.
        ;(req as { on?: (e: string, fn: () => void) => void } | undefined)?.on?.('close', cleanup)
        res.on('close', cleanup)
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/cancel`,
      handler: (req: unknown, res: ServerResponse) => {
        const chunks: Buffer[] = []
        ;(req as { on: (e: string, fn: (c: Buffer) => void) => void }).on('data', (c: Buffer) =>
          chunks.push(c),
        )
        ;(req as { on: (e: string, fn: () => void) => void }).on('end', () => {
          let sessionId: string | undefined
          try {
            sessionId = (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { sessionId?: string })
              .sessionId
          } catch {
            // ignore
          }
          if (sessionId) queue.cancel(sessionId)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/config`,
      // The host router matches on path only (no method field), so GET/POST
      // share this route and branch on req.method.
      handler: async (req: unknown, res: ServerResponse) => {
        const method = (req as { method?: string }).method ?? 'GET'
        if (method !== 'POST') {
          sendJson(res, 200, await snapshot())
          return
        }
        readJsonBody(req, async (body) => {
          const patch: Partial<VoiceSettings> = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (typeof body.engine === 'string') patch.engine = body.engine
          // Voice ids are engine-specific: switching engines invalidates the
          // saved voice, so clear it instead of feeding A's voice to B.
          if (typeof body.engine === 'string' && body.engine !== settings.engine) patch.voice = ''
          if (typeof body.voice === 'string') patch.voice = body.voice
          if (body.volume !== undefined) {
            const vol = Number(body.volume)
            patch.volume = Number.isFinite(vol) ? Math.min(200, Math.max(0, Math.round(vol))) : 100
          }
          if (body.fontSize !== undefined) {
            const fs = Number(body.fontSize)
            patch.fontSize = Number.isFinite(fs) ? Math.min(30, Math.max(10, Math.round(fs))) : 16
          }
          if (typeof body.thinkingEngine === 'string') {
            // '' = default (edge-tts + Xiaoyi); otherwise an engine id.
            patch.thinkingEngine = body.thinkingEngine
          }
          if (typeof body.captionColor1 === 'string' && /^#[0-9a-f]{6}$/i.test(body.captionColor1)) patch.captionColor1 = body.captionColor1
          if (typeof body.captionColor2 === 'string' && /^#[0-9a-f]{6}$/i.test(body.captionColor2)) patch.captionColor2 = body.captionColor2
          if (body.shimmerSec !== undefined) {
            const sec = Number(body.shimmerSec)
            patch.shimmerSec = Number.isFinite(sec) ? Math.min(15, Math.max(1, sec)) : 4
          }
          if (body.rate !== undefined) {
            const rate = Number(body.rate)
            patch.rate = Number.isFinite(rate) ? Math.min(200, Math.max(-75, Math.round(rate))) : 0
          }
          settings = saveSettings(patch)
          queue.configure({ voice: settings.voice, rate: settings.rate, volume: settings.volume })
          // Engines may have appeared/disappeared (engines/ dir) → rebuild.
          refreshEngine()
          enginesCache = null
          // Panel pressed 重置悬浮框位置 → tell every voice bar to snap back
          // to its default spot.
          if (body.resetPos === true) broadcast('config', { resetPos: true })

          // NOTE: no auto-load here by design — toggling the switch or picking
          // a model in the dropdown must not start a ~40 s model load; that is
          // boot-time-only (pushAutoLoad), the manual buttons, or first speech.
          // Let every connected voice bar mirror the change instantly (e.g.
          // the master toggle), instead of waiting for its next poll.
          if ('enabled' in patch) broadcast('config', { enabled: settings.enabled })
          // Push caption style changes to every voice bar instantly.
          if (patch.captionColor1 || patch.captionColor2 || patch.shimmerSec !== undefined) {
            broadcast('config', {
              captionColor1: settings.captionColor1,
              captionColor2: settings.captionColor2,
              shimmerSec: settings.shimmerSec,
            })
          }
          // Live volume: the client attenuates <=100 itself; >100 needs a
          // fresh synthesis, so push the value for playback gain right away.
          if (patch.volume !== undefined) broadcast('config', { volume: settings.volume })
          if (patch.fontSize !== undefined) broadcast('config', { fontSize: settings.fontSize })
          sendJson(res, 200, await snapshot())
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/preview`,
      handler: (req: unknown, res: ServerResponse) => {
        readJsonBody(req, async (body) => {
          // The panel sends raw text: run the same markdown cleanup the chat
          // pipeline uses, otherwise Edge voices stray '**' etc.
          const raw = typeof body.text === 'string' ? body.text.trim() : ''
          const text = raw ? plainText(raw).trim() : ''
          if (!text) {
            sendJson(res, 400, { ok: false, error: 'text required' })
            return
          }
          const rateRaw = Number(body.rate)
          const rate =
            body.rate === undefined || !Number.isFinite(rateRaw)
              ? settings.rate
              : Math.min(200, Math.max(-75, Math.round(rateRaw)))
          const voice = typeof body.voice === 'string' && body.voice ? body.voice : settings.voice
          // An explicit engine override must win over the active engine so the
          // settings panel can audition an engine before switching to it.
          const wantedId = typeof body.engine === 'string' ? body.engine : ''
          const target =
            (wantedId && wantedId !== 'auto' ? findProvider(wantedId) : undefined) ??
            (wantedId === 'auto' ? await picked.catch(() => engine) : engine)

          // Auditioning must be instant and predictable: if a remote model is
          // not ready, fail fast with a clear reason instead of silently
          // spending ~40 s on a load the user did not ask for (or surfacing a
          // raw "fetch failed" while the sidecar restarts after a full unload).
          if (typeof target.modelStatus === 'function') {
            const st = await target.modelStatus().catch(() => null)
            if (st === null) {
              sendJson(res, 409, {
                ok: false,
                code: 'MODEL_UNAVAILABLE',
                engine: target.id,
                error: '本地模型不可达：sidecar 未运行或正在重启，稍候再试',
              })
              return
            }
            if (st.loading) {
              sendJson(res, 409, {
                ok: false,
                code: 'MODEL_LOADING',
                engine: target.id,
                error: '本地模型正在加载中，请稍候（约 40 秒）',
              })
              return
            }
            if (!st.loaded) {
              sendJson(res, 409, {
                ok: false,
                code: 'MODEL_NOT_LOADED',
                engine: target.id,
                error: '本地模型未加载（点「加载模型」或开启自动加载后再试）',
              })
              return
            }
          }

          try {
            const audio = await target.synthesize(text, { voice: voice || undefined, rate })
            sendJson(res, 200, {
              ok: true,
              audio: audio.toString('base64'),
              mime: target.outputFormat,
              engine: target.id,
              voice: voice || '',
              rate,
              chars: text.length,
            })
          } catch (e) {
            sendJson(res, 502, {
              ok: false,
              engine: target.id,
              error: String(e instanceof Error ? e.message : e),
            })
          }
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/test-speak`,
      handler: (req: unknown, res: ServerResponse) => {
        if (!config.devTest) {
          res.statusCode = 403
          res.end('devTest is disabled')
          return
        }
        const chunks: Buffer[] = []
        ;(req as { on: (e: string, fn: (c: Buffer) => void) => void }).on('data', (c: Buffer) =>
          chunks.push(c),
        )
        ;(req as { on: (e: string, fn: () => void) => void }).on('end', () => {
          let body: { text?: string; sessionId?: string } = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
          } catch {
            // ignore
          }
          const text = body.text?.trim()
          if (!text) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: 'text required' }))
            return
          }
          const sessionId = body.sessionId || 'dev-test'
          queue.enqueue(sessionId, text)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, sessionId, queued: text }))
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: base,
      handler: async (_req: unknown, res: ServerResponse) => {
        const active = await picked.catch(() => engine)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ok: true,
            name: 'dsh-voice-reader',
            enabled: settings.enabled,
            engine: active.id,
          }),
        )
      },
    }),
  )

  // Register a cloud (OpenAI-format) engine from the settings panel. The
  // declaration lands in ~/.dsh/voice-reader/engines/ and becomes selectable
  // immediately (registry rebuild + cache invalidation).
  // Update the style/voice-description of an existing cloud engine without
  // touching its credentials.
  // Unregister a cloud engine (removes the declaration file). If it was the
  // selected engine, fall back to `auto` so playback keeps working.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/engines/delete`,
      handler: (req: unknown, res: ServerResponse) => {
        readJsonBody(req, (body) => {
          const id = typeof body.id === 'string' ? body.id : ''
          if (!id || !deleteEngineDeclaration(id)) {
            sendJson(res, 404, { ok: false, error: 'engine not found' })
            return
          }
          if (settings.engine === id) {
            settings = saveSettings({ engine: 'auto', voice: '' })
          }
          refreshEngine()
          enginesCache = null
          sendJson(res, 200, { ok: true, id })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/thinking/generate`,
      handler: (_req: unknown, res: ServerResponse) => {
        // Batch-generate every missing waiting phrase for the currently
        // selected waiting engine (settings panel button). Responds when the
        // whole batch is done (seconds; the panel shows a busy state).
        void ensureThinkingAudio()
          .then((r) => sendJson(res, 200, { ok: true, ...r }))
          .catch((e: unknown) =>
            sendJson(res, 500, { ok: false, error: String(e).slice(0, 200) }),
          )
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/thinking/clear`,
      handler: (_req: unknown, res: ServerResponse) => {
        // Remove every waiting-phrase audio file (all models). The directory
        // is plugin-owned and dedicated, so a pattern-filtered flat wipe is
        // safe: regular files ending in .mp3 / .wav only, no recursion.
        let removed = 0
        try {
          if (existsSync(THINK_CACHE_DIR)) {
            for (const f of readdirSync(THINK_CACHE_DIR)) {
              if (!/\.(mp3|wav)$/i.test(f)) continue
              try {
                unlinkSync(join(THINK_CACHE_DIR, f))
                removed++
              } catch {
                // locked / vanished between listing and unlink — skip
              }
            }
          }
        } catch (e: unknown) {
          sendJson(res, 500, { ok: false, error: String(e).slice(0, 200) })
          return
        }
        sendJson(res, 200, { ok: true, removed })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/engines/style`,
      handler: (req: unknown, res: ServerResponse) => {
        readJsonBody(req, (body) => {
          const id = typeof body.id === 'string' ? body.id : ''
          const stylePrompt = typeof body.stylePrompt === 'string' ? body.stylePrompt.trim() : ''
          const decl = loadEngineDeclarations().find((d) => d.id === id)
          if (!decl) {
            sendJson(res, 404, { ok: false, error: 'engine not found' })
            return
          }
          saveEngineDeclaration({ ...decl, stylePrompt: stylePrompt || undefined })
          refreshEngine()
          enginesCache = null
          sendJson(res, 200, { ok: true, id, stylePrompt })
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${base}/engines`,
      handler: (req: unknown, res: ServerResponse) => {
        const method = (req as { method?: string }).method ?? 'GET'
        if (method !== 'POST') {
          sendJson(res, 200, { ok: true, engines: loadEngineDeclarations() })
          return
        }
        readJsonBody(req, (body) => {
          const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
          const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
          const model = typeof body.model === 'string' ? body.model.trim() : ''
          const voice = typeof body.voice === 'string' ? body.voice.trim() : ''
          if (!baseUrl || !apiKey || !model) {
            sendJson(res, 400, { ok: false, error: 'baseUrl / apiKey / model 必填' })
            return
          }
          if (!/^https?:\/\//i.test(baseUrl)) {
            sendJson(res, 400, { ok: false, error: 'baseUrl 必须以 http(s):// 开头' })
            return
          }
          // Alias is optional: when empty the model id doubles as the display
          // name (and the id source).
          const label = alias || model
          const id = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
          if (!id) {
            sendJson(res, 400, { ok: false, error: '别名/模型 id 需包含字母或数字' })
            return
          }
          saveEngineDeclaration({
            id,
            label,
            url: baseUrl,
            kind: 'openai',
            apiKey,
            model,
            voice: voice || undefined,
          })
          refreshEngine()
          enginesCache = null
          sendJson(res, 200, { ok: true, id, label })
        })
      },
    }),
  )

  // ---- llm/stream lossless tap → segment → enqueue ----
  const sessionSegmenters = new Map<string, SentenceSegmenter>()

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const sessionId = options.sessionId
    // Read the live setting so the panel's toggle takes effect immediately.
    if (!settings.enabled || sessionId === undefined) return next()
    // The model is chewing: start the voiced phrase loop (text + matching
    // audio per switch) until the first real sentence takes the queue or the
    // stream ends.
    broadcast('status', { phase: 'thinking' })
    startThinkingLoop(sessionId)
    return tapStream(sessionId, next(), queue, sessionSegmenters, () => {
      stopThinkingLoop(sessionId)
      broadcast('status', { phase: 'idle' })
    })
  })
}

async function* tapStream(
  sessionId: string,
  inner: AsyncIterable<StreamChunk>,
  queue: SpeakQueue,
  sessionSegmenters: Map<string, SentenceSegmenter>,
  onDone: () => void,
): AsyncIterable<StreamChunk> {
  const segmenter = new SentenceSegmenter()
  const grouper = new SentenceGrouper()
  sessionSegmenters.set(sessionId, segmenter)
  let flushed = false
  let finishReason: unknown = null
  const flushOnce = (): void => {
    if (flushed) return
    flushed = true
    for (const s of segmenter.flush())
      for (const g of grouper.push(s)) queue.enqueue(sessionId, g)
    for (const g of grouper.flush()) queue.enqueue(sessionId, g)
  }
  try {
    for await (const chunk of inner) {
      if (chunk.type === 'text-delta' && chunk.text) {
        for (const s of segmenter.feed(chunk.text))
          for (const g of grouper.push(s)) queue.enqueue(sessionId, g)
      }
      if (chunk.type === 'finish') finishReason = chunk.reason
      yield chunk
    }
  } finally {
    // A user stop aborts the turn: the trailing half-sentence is exactly what
    // the user interrupted, so it must not be spoken.
    const aborted =
      finishReason !== null &&
      typeof finishReason === 'object' &&
      (finishReason as { kind?: unknown }).kind === 'aborted'
    if (!aborted) flushOnce()
    sessionSegmenters.delete(sessionId)
    onDone()
  }
}
