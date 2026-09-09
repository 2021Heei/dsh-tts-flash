/**
 * dsh-tts-flash — client half.
 *
 * A small voice bar injected into the `shell.overlay` slot. Text only — no
 * status dot and no buttons (the master switch lives in the voice settings
 * panel; SSE `config` events keep the bar's frame filter in sync).
 * - The bar is draggable; the position (viewport coords = relative to the DSH
 *   window) is persisted to localStorage and restored on every launch.
 * - Captions longer than the bar scroll once, timed to the sentence's real
 *   audio duration (no back-scroll), so the text ends as the speech does.
 *
 * It opens an EventSource to the host SSE endpoint and plays `audio` frames
 * back-to-back on the page's single <audio> element.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchConfig, saveConfig } from './client-api.ts'
import { THINK_PHRASES } from './thinking-phrases.ts'
import { VoiceSettingsPanel } from './settings-section.tsx'

interface Frame {
  sessionId: string
  seq: number
  text: string
  audio: string
  mime?: string
}

export interface VoiceBarState {
  connected: boolean
  enabled: boolean
  playing: boolean
  /** Model is generating but no audio has arrived yet → thinking phrases. */
  thinking: boolean
  /** Host-driven current phrase text (null → local rotation fallback). */
  thinkingText: string | null
  caption: string | null
  /** Real duration (ms) of the currently playing audio — drives marquee speed. */
  captionMs: number | null
  /** Playback volume percent (100 = normal; >100 handled at synthesis). */
  volume: number
  /** Caption gradient colors [start, end] from the settings panel. */
  colors: [string, string]
  /** Caption font size in px (from the settings panel). */
  fontSize: number
  /** Shimmer cycle duration in seconds. */
  shimmerSec: number
}

export interface VoiceBarActions {
  connect(): void
  disconnect(): void
  toggle(): void
  skip(): void
  subscribe(fn: (s: VoiceBarState) => void): () => void
}

export const inject = ['slots']

export function apply(ctx: any): void {
  const engine = createAudioEngine()

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'tts-flash',
        order: 500,
        inject: (): VoiceBarActions => engine,
      },
      VoiceReaderBar,
    ),
  )

  // 设置面板子界面。DSH 0.1.x 只从注册里取 id / order / label，
  // 组件 props = inject() 的返回值（与 dsh-better-sidebar 用法一致）。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'tts-flash-settings',
        order: 400,
        label: () => '语音设置',
        inject: () => ({ title: '语音朗读' }),
      },
      VoiceSettingsPanel,
    ),
  )
}

// ---------------------------------------------------------------------------

const BASE = '/dsh-tts-flash'
const LS_KEY = 'dsh-tts-flash.enabled'
const MAX_CLIENT_QUEUE = 8 // frames; beyond this, oldest audio is dropped

// Idle-while-generating phrases live in ./thinking-phrases.ts — shared with
// the host so text rotation and audio files stay 1:1. Switch interval is
// FIXED + a small random jitter (never rhythmical).
const THINK_FIXED_MS = 2400 // base switch interval
const THINK_JITTER_MS = 900 // + 0..900 ms random → never rhythmical

function base64ToAudioUrl(b64: string, mime = 'audio/mpeg'): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(LS_KEY) !== '0'
  } catch {
    return true
  }
}

function createAudioEngine(): VoiceBarActions {
  let es: EventSource | null = null
  const audio = new Audio()
  let queue: Frame[] = []
  let activeSession: string | null = null

  // ObjectURL of the frame currently loaded into `audio` — revoked on swap so
  // long conversations do not leak one blob URL per sentence.
  let currentUrl: string | null = null

  let state: VoiceBarState = {
    connected: false,
    enabled: loadEnabled(),
    playing: false,
    thinking: false,
    thinkingText: null,
    caption: null,
    captionMs: null,
    volume: 100,
    colors: ['#5b8cff', '#ffffff'],
    fontSize: 16,
    shimmerSec: 4,
  }
  const listeners = new Set<(s: VoiceBarState) => void>()
  const notify = (): void => {
    const snapshot = { ...state }
    for (const fn of listeners) {
      try {
        fn(snapshot)
      } catch {
        // subscriber errors must not break the engine
      }
    }
  }
  const set = (patch: Partial<VoiceBarState>): void => {
    state = { ...state, ...patch }
    notify()
  }

  const playNext = (): void => {
    if (state.playing || queue.length === 0) return
    const frame = queue.shift()!
    set({ playing: true, caption: frame.text, captionMs: null })
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl)
      currentUrl = null
    }
    currentUrl = base64ToAudioUrl(frame.audio, frame.mime)
    audio.src = currentUrl
    // Playback attenuation for <=100 %; >100 % is amplified at synthesis.
    audio.volume = Math.min(1, (state.volume ?? 100) / 100)
    // Real duration (rate-adjusted by the engine) → marquee speed matches speech.
    audio.onloadedmetadata = () => {
      set({
        captionMs:
          audio.duration && isFinite(audio.duration) ? audio.duration * 1000 : null,
      })
    }
    audio.onended = () => {
      set({ playing: false, caption: null })
      if (queue.length > 0) playNext()
    }
    // A frame that fails to decode/play must not wedge the queue: log, drop,
    // advance to the next sentence.
    audio.onerror = () => {
      console.warn('[tts-flash] audio frame failed — skipping to next')
      audio.onended = null
      set({ playing: false, caption: null })
      playNext()
    }
    audio.play().catch((e) => {
      console.warn('[tts-flash] playback blocked:', e)
      audio.onended = null
      audio.onerror = null
      set({ playing: false, caption: null })
    })
  }

  const onFrame = (frame: Frame): void => {
    activeSession = frame.sessionId
    // NOTE: thinking is NOT cleared here — the waiting phrases themselves
    // arrive as frames; the host's `status: idle` broadcast ends the wait.
    if (!state.enabled) return // autoplay off → drain silently
    // Back-pressure: a long reply must not pile up minutes of audio. Drop the
    // OLDEST queued frames so playback chases the live output.
    while (queue.length >= MAX_CLIENT_QUEUE) queue.shift()
    queue.push(frame)
    if (!state.playing) playNext()
  }

  const connect = (): void => {
    if (es) return
    es = new EventSource(`${BASE}/stream`)
    es.onopen = () => set({ connected: true })
    es.onerror = () => set({ connected: false })
    // The settings panel owns the master switch; mirror it into the bar's
    // frame filter. The host also broadcasts a `config` event over this same
    // stream whenever a setting changes → instant two-way sync.
    void fetchConfig()
      .then((c) =>
        set({
          enabled: c.enabled,
          volume: c.volume ?? 100,
          fontSize: c.fontSize ?? 16,
          colors: [c.captionColor1 ?? '#5b8cff', c.captionColor2 ?? '#ffffff'],
          shimmerSec: c.shimmerSec ?? 4,
        }),
      )
      .then(() => {
        audio.volume = Math.min(1, (state.volume ?? 100) / 100)
      })
      .catch(() => {
        // host unreachable → keep the local (localStorage) value
      })
    es.addEventListener('config', (ev: MessageEvent) => {
      try {
        const cfg = JSON.parse(ev.data) as {
          enabled?: boolean
          resetPos?: boolean
          captionColor1?: string
          captionColor2?: string
          shimmerSec?: number
          volume?: number
          fontSize?: number
        }
        if (cfg.resetPos)
          // The engine cannot touch component state; the bar listens for this
          // window event itself.
          window.dispatchEvent(new CustomEvent('vr-reset-pos'))
        if (cfg.volume !== undefined) {
          set({ volume: cfg.volume })
          audio.volume = Math.min(1, cfg.volume / 100)
        }
        if (cfg.fontSize !== undefined) set({ fontSize: cfg.fontSize })
        if (cfg.captionColor1 || cfg.captionColor2 || cfg.shimmerSec !== undefined) {
          set({
            colors: [cfg.captionColor1 ?? state.colors[0], cfg.captionColor2 ?? state.colors[1]],
            shimmerSec: cfg.shimmerSec ?? state.shimmerSec,
          })
        }
        if (typeof cfg.enabled === 'boolean' && cfg.enabled !== state.enabled) {
          state.enabled = cfg.enabled
          try {
            localStorage.setItem(LS_KEY, cfg.enabled ? '1' : '0')
          } catch {
            // ignore
          }
          notify()
        }
      } catch {
        // malformed event → ignore
      }
    })
    es.addEventListener('status', (ev: MessageEvent) => {
      let st: { phase?: string; text?: string }
      try {
        st = JSON.parse(ev.data) as { phase?: string; text?: string }
      } catch {
        return
      }
      if (st.phase === 'thinking') {
        // The host drives the phrase text (synced with its voice); a status
        // without text keeps the local rotation fallback in charge.
        const text = typeof st.text === 'string' && st.text ? st.text : null
        if (state.thinking !== true || state.thinkingText !== text) {
          set({ thinking: true, thinkingText: text })
        }
      } else if (state.thinking || state.thinkingText) {
        set({ thinking: false, thinkingText: null })
      }
    })
    es.addEventListener('audio', (ev: MessageEvent) => {
      let frame: Frame
      try {
        frame = JSON.parse(ev.data) as Frame
      } catch {
        return
      }
      onFrame(frame)
    })
  }

  const disconnect = (): void => {
    if (!es) return
    es.close()
    es = null
    set({ connected: false })
  }

  const skip = (): void => {
    audio.pause()
    audio.onended = null
    audio.onerror = null
    try {
      audio.removeAttribute('src')
    } catch {
      // ignore
    }
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl)
      currentUrl = null
    }
    queue = []
    set({ playing: false, caption: null })
    if (activeSession) {
      void fetch(`${BASE}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSession }),
      }).catch(() => {
        // cancel route unreachable: playback already skipped locally
      })
    }
  }

  const toggle = (): void => {
    const next = !state.enabled
    state.enabled = next
    try {
      localStorage.setItem(LS_KEY, next ? '1' : '0')
    } catch {
      // ignore storage errors
    }
    if (!next) skip()
    notify()
    void saveConfig({ enabled: next }).catch(() => undefined)
  }

  const subscribe = (fn: (s: VoiceBarState) => void): (() => void) => {
    listeners.add(fn)
    fn({ ...state })
    return () => {
      listeners.delete(fn)
    }
  }

  return { connect, disconnect, toggle, skip, subscribe }
}

/** Persisted bar position in viewport coordinates; x = the bar's CENTER. */
interface BarPos {
  x: number
  y: number
}

// v3: the bar is positioned RELATIVE TO THE CHAT INPUT BOX (top-center
// anchor), stored as an offset from that anchor — so the bar auto-adapts when
// the window resizes or sidebars collapse (same relative spot, any window size).
const OFFSET_KEY = 'dsh-tts-flash.barOffV3'
// User-defined default offset, captured via 「设当前位置为默认」.
const DEFAULT_OFFSET_KEY = 'dsh-tts-flash.barOffDefaultV3'

interface BarOffset {
  dx: number
  dy: number
}

function readOffset(key: string): BarOffset | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<BarOffset> | null
    if (o && typeof o.dx === 'number' && typeof o.dy === 'number') return { dx: o.dx, dy: o.dy }
  } catch {
    // ignore
  }
  return null
}

function loadOffset(): BarOffset | null {
  // Session offset wins; otherwise the user-captured default; otherwise null
  // (= built-in default: horizontally centered just above the input box).
  return readOffset(OFFSET_KEY) ?? readOffset(DEFAULT_OFFSET_KEY)
}

// Sticky anchor state: once we latch onto the chat input we keep it. Naive
// re-scanning on every tick latches onto the WRONG editable element when the
// settings panel opens or the layout shifts, which made the bar jump around.
let anchorEl: Element | null = null
let anchorMisses = 0
let lastAnchor: { cx: number; topY: number } | null = null

/**
 * Locate the chat input box and return its top-center in viewport coords.
 * The DSH layout is [left sidebar][chat area (+ optional right sidebar)]; the
 * input is the bottom-most sizeable text field, so anchoring to it keeps the
 * bar inside the chat region no matter how the window is laid out.
 */
function findChatAnchor(): { cx: number; topY: number } | null {
  // The chat input lives in the bottom part of the window; this filter keeps
  // us away from search boxes / settings-panel fields further up.
  const minTop = window.innerHeight * 0.3
  const ok = (r: DOMRect): boolean =>
    r.width >= 120 && r.height >= 16 && r.top >= minTop && r.bottom <= window.innerHeight + 60

  // 1) Stick to the element we already chose; only re-scan when it is truly
  //    gone from the DOM or unusable.
  if (anchorEl && anchorEl.isConnected) {
    const r = anchorEl.getBoundingClientRect()
    if (ok(r)) {
      anchorMisses = 0
      lastAnchor = { cx: r.left + r.width / 2, topY: r.top }
      return lastAnchor
    }
  } else {
    anchorEl = null
  }

  // 2) Re-scan: bottom-most eligible field wins.
  let best: DOMRect | null = null
  let bestEl: Element | null = null
  for (const el of document.querySelectorAll('textarea, [contenteditable="true"]')) {
    const r = el.getBoundingClientRect()
    if (!ok(r)) continue
    if (!best || r.top > best.top) {
      best = r
      bestEl = el
    }
  }
  if (bestEl && best) {
    anchorEl = bestEl
    anchorMisses = 0
    lastAnchor = { cx: best.left + best.width / 2, topY: best.top }
    return lastAnchor
  }

  // 3) Nothing eligible right now (chat view temporarily unmounted): keep the
  //    last known anchor for a grace period instead of jumping elsewhere.
  anchorMisses++
  if (anchorMisses <= 12 && lastAnchor) return lastAnchor // ~10 s at 800 ms
  return null
}

/**
 * The slot host passes the value returned by `inject()` straight through as
 * the component props (see dsh-voice's VoicePanel). Accept both that shape and
 * a nested `{ actions }` shape so the bar survives API drift.
 */
function VoiceReaderBar(props: VoiceBarActions | { actions: VoiceBarActions }): JSX.Element {
  const actions: VoiceBarActions =
    typeof (props as { subscribe?: unknown }).subscribe === 'function'
      ? (props as VoiceBarActions)
      : (props as { actions: VoiceBarActions }).actions

  const [s, setS] = useState<VoiceBarState>({
    connected: false,
    enabled: true,
    playing: false,
    thinking: false,
    thinkingText: null,
    caption: null,
    volume: 100,
    fontSize: 16,
    colors: ['#5b8cff', '#ffffff'],
    shimmerSec: 4,
  })
  const [anchor, setAnchor] = useState<{ cx: number; topY: number } | null>(null)
  const [off, setOff] = useState<BarOffset | null>(loadOffset)
  const offRef = useRef<BarOffset | null>(off)
  const barRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseOff: BarOffset } | null>(null)
  const capWrapRef = useRef<HTMLSpanElement | null>(null)
  const capRef = useRef<HTMLSpanElement | null>(null)
  const [marquee, setMarquee] = useState(false)
  // Coordinate-system shift: position:fixed inside the slot wrapper is
  // CONTAINED by a transformed ancestor (DSH's overlay wrapper sits below the
  // ~36 px title bar), so style values are wrapper-relative, not viewport.
  // We measure the delta after every commit and subtract it — a constant
  // correction, so it can never compound (unlike delta accumulation).
  const [shift, setShift] = useState({ x: 0, y: 0 })
  const lastStyleRef = useRef<{ left: number; top: number } | null>(null)


  useEffect(() => {
    offRef.current = off
  }, [off])

  // Measure style→visual mismatch after every commit; corrects within the
  // same frame (layout effect fires before paint).
  useLayoutEffect(() => {
    const rect = barRef.current?.getBoundingClientRect()
    const ls = lastStyleRef.current
    if (!rect || !ls) return
    const nx = rect.left + rect.width / 2 - ls.left
    const ny = rect.top - ls.top
    if (Math.abs(nx - shift.x) > 0.5 || Math.abs(ny - shift.y) > 0.5) {
      setShift({ x: nx, y: ny })
    }
  })

  useEffect(() => {
    if (!actions || typeof actions.subscribe !== 'function') return
    const unsubscribe = actions.subscribe(setS)
    actions.connect()
    return () => {
      unsubscribe()
      actions.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track the chat input anchor: re-measure on window resize and periodically
  // (sidebar toggle, conversation switch and other layout changes do not fire
  // window resize events).
  useEffect(() => {
    const update = (): void => {
      setAnchor((prev) => {
        const next = findChatAnchor()
        // Same-value updates would re-render the bar every 800 ms for nothing.
        if (prev && next && Math.abs(prev.cx - next.cx) < 0.5 && Math.abs(prev.topY - next.topY) < 0.5) {
          return prev
        }
        return next
      })
    }
    update()
    const t = setInterval(update, 800)
    window.addEventListener('resize', update)
    return () => {
      clearInterval(t)
      window.removeEventListener('resize', update)
    }
  }, [])

  // Reset position: the settings panel dispatches this window event and also
  // broadcasts a `config` SSE event with resetPos (both paths covered).
  useEffect(() => {
    const reset = (): void => {
      try {
        localStorage.removeItem(OFFSET_KEY)
      } catch {
        // ignore
      }
      setOff(loadOffset()) // falls back to the user default, if one was saved
    }
    window.addEventListener('vr-reset-pos', reset)
    return () => window.removeEventListener('vr-reset-pos', reset)
  }, [])

  // 「设当前位置为默认」: capture the bar's current offset from the chat-input
  // anchor as the default every future launch (and the reset target) uses.
  useEffect(() => {
    const saveDefault = (): void => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect || !anchor) return
      const cur: BarOffset = {
        dx: rect.left + rect.width / 2 - anchor.cx,
        dy: rect.top - anchor.topY,
      }
      try {
        localStorage.setItem(DEFAULT_OFFSET_KEY, JSON.stringify(cur))
      } catch {
        // ignore
      }
    }
    window.addEventListener('vr-save-default-pos', saveDefault)
    return () => window.removeEventListener('vr-save-default-pos', saveDefault)
  }, [anchor])

  // Caption overflow → marquee instead of ellipsis.
  useEffect(() => {
    const wrap = capWrapRef.current
    const inner = capRef.current
    if (!wrap || !inner) {
      setMarquee(false)
      return
    }
    setMarquee(inner.scrollWidth > wrap.clientWidth + 2)
  }, [s.caption])

  // Thinking phrases: while the model generates but no audio has arrived,
  // rotate through a small pool instead of the static 「朗读就绪」. The host
  // normally drives the text (synced with the voice); this LOCAL rotation is
  // only the fallback for status events without a text payload. The switch
  // interval is FIXED + a small random jitter (never rhythmical).
  const [thinkText, setThinkText] = useState(THINK_PHRASES[0])
  useEffect(() => {
    if (!s.connected || !s.thinking || s.thinkingText) return
    let timer: ReturnType<typeof setTimeout>
    const nextDelay = (): number => THINK_FIXED_MS + Math.random() * THINK_JITTER_MS
    setThinkText(THINK_PHRASES[(Math.random() * THINK_PHRASES.length) | 0])
    const tick = (): void => {
      setThinkText((prev) => {
        let next = THINK_PHRASES[(Math.random() * THINK_PHRASES.length) | 0]
        // Never show the same phrase twice in a row.
        while (THINK_PHRASES.length > 1 && next === prev) {
          next = THINK_PHRASES[(Math.random() * THINK_PHRASES.length) | 0]
        }
        return next
      })
      timer = setTimeout(tick, nextDelay())
    }
    timer = setTimeout(tick, nextDelay())
    return () => clearTimeout(timer)
  }, [s.connected, s.thinking])

  // -- dragging (offset from the chat-input anchor; persisted) --
  // Snapshot-based: pointerdown captures the starting offset ONCE; the offset
  // during the drag is a PURE function of (snapshot, current pointer pos). No
  // DOM reads mid-drag, so interleaved re-renders / anchor ticks can never
  // compound the offset (the previous read-rect-every-move version ran away).
  interface DragState {
    startX: number
    startY: number
    baseOff: BarOffset
  }
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('button')) return
    if (!anchor) return
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseOff: {
        dx: rect.left + rect.width / 2 - anchor.cx,
        dy: rect.top - anchor.topY,
      },
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    const next: BarOffset = {
      dx: d.baseOff.dx + (e.clientX - d.startX),
      dy: d.baseOff.dy + (e.clientY - d.startY),
    }
    offRef.current = next // fresh for pointerup even before the re-render
    setOff(next)
  }

  const onPointerUp = (): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (offRef.current) {
      try {
        localStorage.setItem(OFFSET_KEY, JSON.stringify(offRef.current))
      } catch {
        // ignore storage errors
      }
    }
  }

  // Compose the fixed position from the anchor + offset each render. The
  // anchor re-measures on resize/layout change, so the SAME offset auto-adapts
  // to any window size. Until the input box is found, keep the bar hidden.
  const barH = barRef.current?.offsetHeight ?? 34
  const barW = barRef.current?.offsetWidth ?? 240
  let posStyle: React.CSSProperties
  if (!anchor) {
    posStyle = { position: 'fixed', left: -9999, top: -9999, opacity: 0 }
    lastStyleRef.current = null
  } else {
    const dx = off?.dx ?? 0
    // Built-in default: top-center INSIDE the input box's upper area.
    const dy = off?.dy ?? 8
    const half = barW / 2
    const cx = Math.min(Math.max(half, anchor.cx + dx), Math.max(half, window.innerWidth - half))
    const topY = Math.min(Math.max(0, anchor.topY + dy), Math.max(0, window.innerHeight - barH))
    // Convert viewport-desired coords into the wrapper's coordinate system.
    const left = cx - shift.x
    const top = topY - shift.y
    posStyle = { left, top, transform: 'translateX(-50%)' }
    lastStyleRef.current = { left, top }
  }

  // One-way scroll timed to the REAL playing time of the sentence: the text
  // reaches its end exactly when the audio does (the audio is already
  // rate-adjusted). No back-scroll.
  const marqueeDur = Math.max(3, Math.round((s.captionMs ?? 8000) / 1000))

  return (
    <>
      <style>{VR_BAR_CSS}</style>
      <div
      ref={barRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        ...posStyle,
        position: 'fixed',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 12px',
        borderRadius: 999,
        background: 'transparent',
        border: 'none',
        color: '#e6e6e6',
        fontSize: 12,
        lineHeight: 1,
        fontFamily: 'inherit',
        pointerEvents: 'auto',
        userSelect: 'none',
        zIndex: 9999,
        // NOTE: no backdrop-filter here — it forces descendant compositing and
        // Chromium then intermittently drops `background-clip: text` on the
        // caption/idle spans (they render as a solid gradient box).
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      {s.caption ? (
        <span
          ref={capWrapRef}
          style={{
            display: 'inline-block',
            maxWidth: 320,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            verticalAlign: 'middle',
          }}
        >
          <span
            key={s.caption}
            ref={capRef}
            style={{
              display: 'inline-block',
              whiteSpace: 'nowrap',
              fontSize: s.fontSize,
              fontWeight: 600,
              // backgroundImage (not the `background` shorthand): the shorthand
              // resets background-clip, and with inline-style apply order that
              // is a race we do not want to depend on.
              backgroundImage: `linear-gradient(90deg, ${s.colors[0]} 0%, ${s.colors[1]} 50%, ${s.colors[0]} 100%)`,
              backgroundSize: '200% 100%',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              color: 'transparent',
              WebkitTextFillColor: 'transparent',
              animation: `vr-shimmer ${s.shimmerSec}s linear infinite${
                marquee ? `, vr-marquee ${marqueeDur}s linear forwards` : ''
              }`,
            }}
          >
            {s.caption}
          </span>
        </span>
      ) : (
        <span
          style={{
            fontSize: s.fontSize,
            fontWeight: 600,
            backgroundImage: `linear-gradient(90deg, ${s.colors[0]} 0%, ${s.colors[1]} 50%, ${s.colors[0]} 100%)`,
            backgroundSize: '200% 100%',
            backgroundClip: 'text',
            WebkitBackgroundClip: 'text',
            color: 'transparent',
            WebkitTextFillColor: 'transparent',
            // Thinking phrases shimmer faster — livelier, and the quick cycle
            // makes the switch to the real caption feel less abrupt.
            animation: `vr-shimmer ${
              s.thinking ? Math.max(1.2, s.shimmerSec / 2.5) : s.shimmerSec
            }s linear infinite`,
          }}
        >
          {s.connected ? (s.thinking ? (s.thinkingText ?? thinkText) : '朗读就绪') : '未连接'}
        </span>
      )}
    </div>
    </>
  )
}

const VR_BAR_CSS = `
@keyframes vr-marquee {
  0% { transform: translateX(0); }
  100% { transform: translateX(calc(-100% + 320px)); }
}
@keyframes vr-shimmer {
  to { background-position: -200% 0; }
}
`

