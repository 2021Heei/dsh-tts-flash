/**
 * Runtime settings store for dsh-tts-flash.
 *
 * Why a plain JSON file instead of the Cordis config tree: the settings panel
 * writes from the browser on every change (toggle, slider drag, dropdown), and
 * DSH 0.1.x exposes no plugin-config write API to a client bundle. The file
 * lives next to the profile data so it survives plugin reinstall / upgrades:
 *
 *   ~/.dsh/tts-flash/settings.json   — user settings
 *   ~/.dsh/tts-flash/engines/*.json  — drop-in engine declarations
 *
 * Drop-in engines are how "new models appear automatically": drop a file like
 *
 *   { "id": "gpt-sovits", "label": "GPT-SoVITS (本地)", "url": "http://127.0.0.1:9880" }
 *
 * into engines/, and the host probes it (GET {url}/health) and offers it in
 * the settings dropdown. No code change, no rebuild.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface VoiceSettings {
  /** Master switch: read LLM replies aloud. */
  enabled: boolean
  /** 'auto' | provider id. */
  engine: string
  /** Voice id of the active provider ('' = provider default). */
  voice: string
  /** Rate offset in percent: -75 (slow) … 0 (normal) … +200 (fast). */
  rate: number
  /** Playback volume in percent: 0 … 100 (default) … 200 (engine gain). */
  volume: number
  /** Caption font size in px: 10 … 30. */
  fontSize: number
  /** Caption gradient start/end color (hex #rrggbb). */
  captionColor1: string
  captionColor2: string
  /** Shimmer cycle duration in seconds — lower = faster flow. */
  shimmerSec: number
  /** Engine for the waiting (thinking) phrases. '' / 'auto' = edge-tts with
   *  the built-in Xiaoyi voice. */
  thinkingEngine: string
}

export interface EngineDeclaration {
  /** Stable id (used by the engine dropdown + settings file). */
  id: string
  /** Human label shown in the UI. */
  label: string
  /** Base URL: sidecar root, or the OpenAI-format base incl. version path. */
  url: string
  /** 'sidecar' (default) speaks the ChatTTS protocol; 'openai' /audio/speech. */
  kind?: 'sidecar' | 'openai'
  /** Bearer token for openai-kind engines. */
  apiKey?: string
  /** Vendor model id, sent verbatim as the `model` parameter. */
  model?: string
  /** Optional default voice id. */
  voice?: string
  /** Optional user-message content: style instruction or voice description
   *  (MiMo chat-style engines; voicedesign models require it). */
  stylePrompt?: string
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  enabled: true,
  engine: 'auto',
  voice: '',
  rate: 0,
  volume: 100,
  fontSize: 16,
  captionColor1: '#5b8cff',
  captionColor2: '#ffffff',
  shimmerSec: 4,
  thinkingEngine: '',
}

export const DATA_DIR = join(homedir(), '.dsh', 'tts-flash')
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json')
export const ENGINES_DIR = join(DATA_DIR, 'engines')

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    // read-only home: settings simply stay in memory
  }
}

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

/** True once the user (or a previous run) has written settings.json. */
export function hasSettingsFile(): boolean {
  return existsSync(SETTINGS_FILE)
}

/** Load settings, filling in defaults for anything missing/corrupt. */
export function loadSettings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  const raw = readJson(SETTINGS_FILE) as Partial<VoiceSettings> | undefined
  const merged: VoiceSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  const rate = Number(merged.rate)
  return {
    enabled: Boolean(merged.enabled),
    engine: typeof merged.engine === 'string' && merged.engine ? merged.engine : 'auto',
    voice: typeof merged.voice === 'string' ? merged.voice : '',
    rate: Number.isFinite(rate) ? Math.min(200, Math.max(-75, Math.round(rate))) : 0,
    volume: clampNum(merged.volume, 0, 200, 100),
    fontSize: clampNum(merged.fontSize, 10, 30, 16),
    captionColor1: isHex(merged.captionColor1) ? merged.captionColor1 : '#5b8cff',
    captionColor2: isHex(merged.captionColor2) ? merged.captionColor2 : '#ffffff',
    shimmerSec: clampNum(merged.shimmerSec, 1, 15, 4),
    thinkingEngine:
      typeof merged.thinkingEngine === 'string' ? merged.thinkingEngine : '',
    ...overrides,
  }
}

/** Persist a partial update and return the merged result. */
export function saveSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next = loadSettings(patch)
  try {
    ensureDir(DATA_DIR)
    writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (e) {
    console.warn(`[tts-flash] could not persist settings: ${String(e)}`)
  }
  return next
}

/**
 * Read engine declarations dropped into ~/.dsh/tts-flash/engines/*.json.
 * Malformed files are skipped (and reported) instead of breaking startup.
 */
export function loadEngineDeclarations(): EngineDeclaration[] {
  if (!existsSync(ENGINES_DIR)) return []
  let files: string[] = []
  try {
    files = readdirSync(ENGINES_DIR).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch {
    return []
  }
  const out: EngineDeclaration[] = []
  for (const file of files) {
    const raw = readJson(join(ENGINES_DIR, file)) as Partial<EngineDeclaration> | undefined
    if (!raw || typeof raw.id !== 'string' || typeof raw.url !== 'string') {
      console.warn(`[tts-flash] ignoring malformed engine file: ${file}`)
      continue
    }
    const rawKind = raw.kind === 'openai' ? 'openai' : 'sidecar'
    out.push({
      id: raw.id,
      label: typeof raw.label === 'string' && raw.label ? raw.label : raw.id,
      url: raw.url,
      kind: rawKind,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      voice: typeof raw.voice === 'string' ? raw.voice : undefined,
      stylePrompt: typeof raw.stylePrompt === 'string' ? raw.stylePrompt : undefined,
    })
  }
  return out
}

/** Remove an engine declaration file (unregister from the settings panel). */
export function deleteEngineDeclaration(id: string): boolean {
  try {
    const file = join(ENGINES_DIR, `${id.replace(/[^\w.-]+/g, '_')}.json`)
    if (!existsSync(file)) return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** Write/update one engine declaration (used by tests + future UI). */
export function saveEngineDeclaration(decl: EngineDeclaration): void {
  try {
    ensureDir(ENGINES_DIR)
    writeFileSync(
      join(ENGINES_DIR, `${decl.id.replace(/[^\w.-]+/g, '_')}.json`),
      `${JSON.stringify(decl, null, 2)}\n`,
      'utf8',
    )
  } catch (e) {
    console.warn(`[tts-flash] could not write engine file: ${String(e)}`)
  }
}
