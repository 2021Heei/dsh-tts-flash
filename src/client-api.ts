/**
 * Client ↔ host API for the voice settings panel.
 *
 * Everything is a relative fetch against the plugin's own base path, so it
 * works no matter which origin the DSH shell is served from.
 */

export const BASE = '/dsh-tts-flash'

export interface EngineInfo {
  id: string
  label: string
  streaming: boolean
  available: boolean
  /** 'sidecar' | 'openai' — cloud chat-style engines are editable. */
  apiStyle?: string
  /** Current style/voice-description (openai chat engines). */
  stylePrompt?: string
}

export interface VoiceInfo {
  id: string
  name: string
}

export interface VoiceSettingsDto {
  enabled: boolean
  /** Engine actually in use (after auto-detection / fallback). */
  engine: string
  /** What the user selected ('auto' or an explicit id). */
  engineRequested: string
  voice: string
  rate: number
  /** Caption gradient colors + shimmer speed (seconds per cycle). */
  captionColor1: string
  captionColor2: string
  shimmerSec: number
  /** Waiting-phrase voice engine ('' = default: edge-tts + Xiaoyi). */
  thinkingEngine: string
  basePath: string
  devTest: boolean
  engines: EngineInfo[]
  voices: VoiceInfo[]
}

export interface PreviewResult {
  audio: string
  mime: string
  engine: string
  voice: string
  rate: number
  chars: number
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    throw new Error(`服务端返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error
    throw new Error(msg || `请求失败（HTTP ${res.status}）`)
  }
  return body as T
}

export function fetchConfig(): Promise<VoiceSettingsDto> {
  return getJson<VoiceSettingsDto>(`${BASE}/config`)
}

export function saveConfig(
  patch: Partial<
    Pick<
      VoiceSettingsDto,
      | 'enabled'
      | 'engine'
      | 'voice'
      | 'rate'
      | 'captionColor1'
      | 'captionColor2'
      | 'shimmerSec'
      | 'thinkingEngine'
    > & {
      resetPos: boolean
    }
  >,
): Promise<VoiceSettingsDto> {
  return getJson<VoiceSettingsDto>(`${BASE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** Batch-generate every missing waiting phrase for the selected engine. */
export function thinkingGenerate(): Promise<{
  ok: boolean
  prefix: string
  generated: number
  total: number
}> {
  return getJson(`${BASE}/thinking/generate`, { method: 'POST' })
}

/** Delete every waiting-phrase audio file (all models). */
export function thinkingClear(): Promise<{ ok: boolean; removed: number }> {
  return getJson(`${BASE}/thinking/clear`, { method: 'POST' })
}

export interface RegisterEngineBody {
  alias: string
  baseUrl: string
  apiKey: string
  model: string
  voice?: string
  stylePrompt?: string
}

export function registerEngine(body: RegisterEngineBody): Promise<{ ok: boolean; id: string; label: string }> {
  return getJson(`${BASE}/engines`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function saveEngineStyle(id: string, stylePrompt: string): Promise<void> {
  return getJson(`${BASE}/engines/style`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, stylePrompt }),
  }).then(() => undefined)
}

export function deleteEngine(id: string): Promise<void> {
  return getJson(`${BASE}/engines/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then(() => undefined)
}

export function preview(
  text: string,
  overrides: { engine?: string; voice?: string; rate?: number } = {},
): Promise<PreviewResult> {
  return getJson<PreviewResult>(`${BASE}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...overrides }),
  })
}
