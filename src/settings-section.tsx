/**
 * 语音设置 —— DSH 设置面板里的一个子界面（settings.section 槽位）。
 *
 * 契约（与 dsh-better-sidebar 一致）：
 *   ctx.slots.register({ name:'settings.section', id, order, label }, Component)
 * 组件 props = register 描述里 inject() 的返回值本身。
 *
 * 面板内容：朗读开关 / 语音模型（自动探测）/ 人声 / 语速 + 底部试听区。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteEngine,
  fetchConfig,
  registerEngine,
  saveEngineStyle,
  preview,
  saveConfig,
  thinkingClear,
  thinkingGenerate,
  type EngineInfo,
  type VoiceInfo,
  type VoiceSettingsDto,
} from './client-api.ts'

export interface VoiceSettingsPanelProps {
  /** Section title (kept injectable so it can be localized later). */
  title?: string
}

const PRESET_TEXTS: { label: string; text: string }[] = [
  { label: '日常问候', text: '你好，我是你的语音助手，这段话用来测试朗读效果。' },
  {
    label: '中英混排',
    text: 'DeepSeek Harness 的插件系统基于 Cordis，边流式输出边朗读是完全可行的。',
  },
  { label: '数字与符号', text: '当前版本 0.1.0，语速可调范围 -50% 到 +100%，默认 0%。' },
  { label: '长句停顿', text: '这是一段较长的测试文本；它包含一个分号，用来检查分句是否合理。后面还有一句。' },
]

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string }

export function VoiceSettingsPanel(props: VoiceSettingsPanelProps): JSX.Element {
  const [cfg, setCfg] = useState<VoiceSettingsDto | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [text, setText] = useState(PRESET_TEXTS[0].text)
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [floatMsg, setFloatMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null)
  const [floatKey, setFloatKey] = useState(0)
  const [reg, setReg] = useState({ baseUrl: '', apiKey: '', model: '', alias: '', stylePrompt: '' })
  const [styleDraft, setStyleDraft] = useState('')
  const [styleMsg, setStyleMsg] = useState('')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [regBusy, setRegBusy] = useState(false)
  const [regMsg, setRegMsg] = useState('')
  const [thinkBusy, setThinkBusy] = useState(false)
  const [thinkMsg, setThinkMsg] = useState('')
  const [thinkClearArmed, setThinkClearArmed] = useState(false)
  const [engOpen, setEngOpen] = useState(false)

  // ---- load ----
  useEffect(() => {
    let alive = true
    fetchConfig()
      .then((c) => {
        if (!alive) return
        setCfg(c)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  const apply = useCallback(async (patch: Parameters<typeof saveConfig>[0]) => {
    // Optimistic: the panel stays responsive while the host persists + re-probes.
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev))
    setSaving(true)
    try {
      const next = await saveConfig(patch)
      setCfg(next)
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [])

  // Native color inputs fire onChange continuously while picking; debounce so
  // a drag across the palette does not flood POST /config (one call per 500ms).
  const colorTimers = useRef<Partial<Record<'captionColor1' | 'captionColor2', ReturnType<typeof setTimeout>>>>({})
  const applyColorDebounced = (key: 'captionColor1' | 'captionColor2', value: string): void => {
    const t = colorTimers.current[key]
    if (t) clearTimeout(t)
    colorTimers.current[key] = setTimeout(() => {
      if (key === 'captionColor1') void apply({ captionColor1: value })
      else void apply({ captionColor2: value })
    }, 500)
  }

  const engines: EngineInfo[] = useMemo(() => cfg?.engines ?? [], [cfg])
  // The selected cloud (openai chat-style) engine — its 音色描述 is editable.
  const cloudEngine = useMemo(
    () => engines.find((e) => e.apiStyle === 'openai' && e.id === cfg?.engineRequested) ?? null,
    [engines, cfg?.engineRequested],
  )

  useEffect(() => {
    setStyleDraft(cloudEngine?.stylePrompt ?? '')
    setStyleMsg('')
    setDeleteArmed(false)
  }, [cloudEngine?.id, cloudEngine?.stylePrompt])

  const doDeleteEngine = useCallback(() => {
    if (!cloudEngine) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      setStyleMsg('再点一次确认删除该引擎')
      return
    }
    deleteEngine(cloudEngine.id)
      .then(() => {
        setDeleteArmed(false)
        setStyleMsg('')
        return fetchConfig().then((c) => setCfg(c))
      })
      .catch((e: unknown) => setStyleMsg(`删除失败：${e instanceof Error ? e.message : String(e)}`))
  }, [cloudEngine, deleteArmed])

  const saveStyle = useCallback(() => {
    if (!cloudEngine) return
    saveEngineStyle(cloudEngine.id, styleDraft)
      .then(() => {
        setStyleMsg('已保存')
        return fetchConfig().then((c) => setCfg(c))
      })
      .catch((e: unknown) => setStyleMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`))
  }, [cloudEngine, styleDraft])
  // ---- 添加云端引擎（二级弹窗内） ----
  const doAddEngine = useCallback(() => {
    setRegBusy(true)
    setRegMsg('')
    registerEngine({ ...reg, voice: undefined })
      .then((r) => {
        setRegMsg(`已添加「${r.label}」，可在「语音模型」下拉中选择`)
        setReg({ baseUrl: '', apiKey: '', model: '', alias: '', stylePrompt: '' })
        return fetchConfig().then((c) => setCfg(c))
      })
      .catch((e: unknown) => {
        setRegMsg(`添加失败：${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => setRegBusy(false))
  }, [reg])

  const voices: VoiceInfo[] = useMemo(() => cfg?.voices ?? [], [cfg])

  // Make sure the selected voice is present in the dropdown even before the
  // (async) voice list arrives.
  const voiceOptions = useMemo(() => {
    const list = [...voices]
    if (cfg?.voice && !list.some((v) => v.id === cfg.voice)) {
      list.unshift({ id: cfg.voice, name: cfg.voice })
    }
    return list
  }, [voices, cfg?.voice])

  const stopPreview = useCallback(() => {
    const el = audioRef.current
    if (el) {
      el.pause()
      el.currentTime = 0
    }
  }, [])

  const floatTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showFloat = useCallback((text: string, kind: 'ok' | 'error') => {
    setFloatMsg({ text, kind })
    setFloatKey((k) => k + 1)
    if (floatTimer.current) clearTimeout(floatTimer.current)
    floatTimer.current = setTimeout(() => setFloatMsg(null), 3000)
  }, [])

  useEffect(
    () => () => {
      if (floatTimer.current) clearTimeout(floatTimer.current)
    },
    [],
  )

  // ---- 等待期语音：批量生成 / 清理 ----
  // NOTE: must live BELOW showFloat's declaration — the useCallback dep array
  // is evaluated during render, and referencing a later const there is a TDZ
  // crash that takes the whole settings panel down.
  const doThinkGenerate = useCallback(async () => {
    setThinkBusy(true)
    setThinkMsg('生成中…（按所选等待语音模型逐条合成）')
    setThinkClearArmed(false)
    try {
      const r = await thinkingGenerate()
      setThinkMsg(
        r.generated > 0
          ? `完成：新生成 ${r.generated} / ${r.total} 条（前缀 ${r.prefix}）`
          : `全部已存在，无需生成（共 ${r.total} 条，前缀 ${r.prefix}）`,
      )
      showFloat('✓ 等待语音已就绪', 'ok')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setThinkMsg(`生成失败：${msg}`)
      showFloat(`生成失败：${msg}`, 'error')
    } finally {
      setThinkBusy(false)
    }
  }, [showFloat])

  const doThinkClear = useCallback(async () => {
    if (!thinkClearArmed) {
      setThinkClearArmed(true)
      setThinkMsg('再点一次确认清理全部等待语音文件（所有模型）')
      return
    }
    setThinkClearArmed(false)
    try {
      const r = await thinkingClear()
      setThinkMsg(`已清理 ${r.removed} 个语音文件`)
    } catch (e: unknown) {
      setThinkMsg(`清理失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [thinkClearArmed])

  const runPreview = useCallback(async () => {
    const value = text.trim()
    if (!value) {
      setStatus({ kind: 'error', text: '请先输入或选择一段测试文字' })
      return
    }
    stopPreview()
    setStatus({ kind: 'busy', text: '正在合成…' })
    try {
      const res = await preview(value, {
        engine: cfg?.engineRequested && cfg.engineRequested !== 'auto' ? cfg.engineRequested : undefined,
        voice: cfg?.voice || undefined,
        rate: cfg?.rate ?? 0,
      })
      const el = audioRef.current ?? new Audio()
      audioRef.current = el
      el.src = `data:${res.mime || 'audio/mpeg'};base64,${res.audio}`
      el.onended = () => setStatus({ kind: 'idle', text: '' })
      await el.play()
      setStatus({
        kind: 'ok',
        text: `已由 ${res.engine} 合成（${res.chars} 字，语速 ${res.rate > 0 ? '+' : ''}${res.rate}%）`,
      })
      showFloat(`✓ 已由 ${res.engine} 合成`, 'ok')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ kind: 'error', text: msg })
      showFloat(msg, 'error')
    }
  }, [text, cfg, stopPreview, showFloat])

  useEffect(() => stopPreview, [stopPreview])

  // Dragging the slider must not fire one save per step (each save re-probes
  // every engine), so coalesce to a single request after the drag settles.
  const changeRate = useCallback(
    (value: number) => {
      setCfg((prev) => (prev ? { ...prev, rate: value } : prev))
      if (rateTimer.current) clearTimeout(rateTimer.current)
      rateTimer.current = setTimeout(() => {
        void apply({ rate: value })
      }, 400)
    },
    [apply],
  )

  useEffect(
    () => () => {
      if (rateTimer.current) clearTimeout(rateTimer.current)
    },
    [],
  )

  // Keep the master toggle in sync with the floating bar (the bar pushes its
  // own changes; only `enabled` is merged so in-flight edits are not clobbered).
  useEffect(() => {
    const t = setInterval(() => {
      fetchConfig()
        .then((c) => setCfg((prev) => (prev && prev.enabled !== c.enabled ? { ...prev, enabled: c.enabled } : prev)))
        .catch(() => undefined)
    }, 8000)
    return () => clearInterval(t)
  }, [])

  if (loadError && !cfg) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.title}>{props.title ?? '语音朗读'}</div>
          <div style={styles.error}>无法读取语音设置：{loadError}</div>
          <div style={styles.hint}>确认插件已加载，并重新打开 DSH 后再试。</div>
        </div>
      </div>
    )
  }

  const rate = cfg?.rate ?? 0

  return (
    <div style={styles.page}>
      <style>{VR_FLOAT_CSS}</style>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <div style={styles.title}>{props.title ?? '语音朗读'}</div>
          <span style={styles.badge(saving)}>{saving ? '保存中…' : '已保存'}</span>
        </div>

        {/* 朗读开关 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>朗读开关</div>
            <div style={styles.rowHint}>关闭后，AI 回复不再自动朗读（浮条仍可手动开关）</div>
          </div>
          <button
            type="button"
            onClick={() => void apply({ enabled: !cfg?.enabled })}
            style={styles.switch(cfg?.enabled ?? false)}
            aria-pressed={cfg?.enabled ?? false}
          >
            <span style={styles.knob(cfg?.enabled ?? false)} />
          </button>
        </div>

        {/* 云端引擎：入口按钮，添加表单在二级弹窗中 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>云端引擎（OpenAI 兼容）</div>
            <div style={styles.rowHint}>
              已添加 {engines.filter((e) => e.apiStyle === 'openai').length} 个云端引擎，点击右侧按钮
              添加新的厂商模型（baseURL / API Key / 模型 id / 别名），添加后即可在
              「语音模型」下拉中选择
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setEngOpen(true)
              setRegMsg('')
            }}
            style={styles.ghostButton}
          >
            云端引擎
          </button>
        </div>

        {/* 语音模型 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>语音模型</div>
            <div style={styles.rowHint}>
              自动 = 使用 Edge TTS，否则使用所选引擎。新模型在
              <code style={styles.code}> ~/.dsh/voice-reader/engines/ </code>
              放一个 JSON 声明即可自动出现
            </div>
          </div>
          <select
            value={cfg?.engineRequested ?? 'auto'}
            onChange={(e) => void apply({ engine: e.target.value })}
            style={styles.select}
          >
            <option value="auto" style={styles.option}>
              自动检测
            </option>
            {engines.map((eng) => (
              <option key={eng.id} value={eng.id} style={styles.option}>
                {eng.label}
                {eng.available ? '' : '（未就绪）'}
              </option>
            ))}
          </select>
        </div>

        {/* 等待期语音模型 + 批量生成/清理 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>等待期语音模型</div>
            <div style={styles.rowHint}>
              AI 思考等待时浮条短语（共 5 条）的语音来源；不指定则默认 Edge 小艺
              （zh-CN-XiaoyiNeural）。语音文件按「模型-音色」前缀命名、与文本一一对应，
              开始对话时若缺失会自动用所选模型一次性补齐
            </div>
          </div>
          <select
            value={cfg?.thinkingEngine ?? ''}
            onChange={(e) => void apply({ thinkingEngine: e.target.value })}
            style={styles.select}
          >
            <option value="" style={styles.option}>
              默认（Edge 小艺）
            </option>
            {engines.map((eng) => (
              <option key={eng.id} value={eng.id} style={styles.option}>
                {eng.label}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>等待语音文件</div>
            <div style={styles.rowHint}>
              {thinkMsg || '生成当前所选等待语音模型的全部 5 条短语；清理会删除所有模型的等待语音'}
            </div>
          </div>
          <div style={styles.modelButtons}>
            <button
              type="button"
              onClick={() => void doThinkGenerate()}
              disabled={thinkBusy}
              style={styles.ghostButton}
            >
              {thinkBusy ? '生成中…' : '批量生成语音'}
            </button>
            <button
              type="button"
              onClick={() => void doThinkClear()}
              disabled={thinkBusy}
              style={styles.ghostButton}
            >
              {thinkClearArmed ? '确认清理？' : '清理语音文件'}
            </button>
          </div>
        </div>

        {/* 悬浮条位置 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>悬浮条位置</div>
            <div style={styles.rowHint}>
              位置相对聊天输入框计算，窗口缩放时自动适应。按住悬浮条可拖动；
              「设为默认」把当前相对位置存为启动默认，「重置」回到输入框内上方居中
            </div>
          </div>
          <div style={styles.modelButtons}>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('vr-save-default-pos'))}
              style={styles.ghostButton}
            >
              设当前位置为默认
            </button>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem('dsh-voice-reader.barOffV3')
                } catch {
                  // ignore
                }
                window.dispatchEvent(new CustomEvent('vr-reset-pos'))
                void saveConfig({ resetPos: true }).catch(() => undefined)
              }}
              style={styles.ghostButton}
            >
              重置悬浮框位置
            </button>
          </div>
        </div>

        {/* 人声 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>人声</div>
            <div style={styles.rowHint}>
              跟随所选模型变化；当前生效模型：{cfg?.engine || '—'}
              {cfg?.engineRequested === 'auto' ? '（自动）' : ''}
              {cfg ? `｜收到 ${cfg.engines?.length ?? 0} 个引擎 / ${cfg.voices?.length ?? 0} 个音色` : ''}
            </div>
          </div>
          <select
            value={cfg?.voice ?? ''}
            onChange={(e) => void apply({ voice: e.target.value })}
            style={styles.select}
          >
            <option value="" style={styles.option}>
              默认音色
            </option>
            {voiceOptions.map((v) => (
              <option key={v.id} value={v.id} style={styles.option}>
                {v.name}
              </option>
            ))}
          </select>
        </div>

        {/* 语速 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>语速</div>
            <div style={styles.rowHint}>
              0% 为原速，可拖动滑块在 -75% ~ +200% 之间调整
              {cfg?.engineRequested === 'edge-tts' ? '；edge 云端引擎实际上限 +100%' : ''}
            </div>
          </div>
          <div style={styles.rateBox}>
            <input
              type="range"
              min={-75}
              max={200}
              step={5}
              value={rate}
              onChange={(e) => changeRate(Number(e.target.value))}
              style={styles.range}
            />
            <span style={styles.rateValue}>
              {rate > 0 ? '+' : ''}
              {rate}%
            </span>
          </div>
        </div>

        {cloudEngine ? (
          <div style={styles.row}>
            <div style={styles.rowMain}>
              <div style={styles.rowLabel}>音色描述 / 风格指令</div>
              <div style={styles.rowHint}>
                「{cloudEngine.label}」的音色与风格。voicedesign/voiceclone 模型此处必填；
                普通 tts 模型可作为自然语言风格指令（含语速要求）
              </div>
              <textarea
                value={styleDraft}
                onChange={(e) => setStyleDraft(e.target.value)}
                rows={2}
                style={styles.textarea}
              />
            </div>
            <button
              type="button"
              onClick={saveStyle}
              style={styles.ghostButton}
            >
              保存
            </button>
            <button
              type="button"
              onClick={doDeleteEngine}
              style={styles.ghostButton}
            >
              {deleteArmed ? '确认删除？' : '删除引擎'}
            </button>
          </div>
        ) : null}
        {cloudEngine && styleMsg ? <div style={styles.rowHint}>{styleMsg}</div> : null}

        {/* 字号 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>字幕字号</div>
            <div style={styles.rowHint}>悬浮条字幕的字体大小，10px ~ 30px</div>
          </div>
          <div style={styles.rateBox}>
            <input
              type="range"
              min={10}
              max={30}
              step={1}
              value={cfg?.fontSize ?? 16}
              onChange={(e) => void apply({ fontSize: Number(e.target.value) })}
              style={styles.range}
            />
            <span style={styles.rateValue}>{cfg?.fontSize ?? 16}px</span>
          </div>
        </div>

        {/* 音量 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>音量</div>
            <div style={styles.rowHint}>
              100% 为原始音量；超过 100% 由引擎增益放大，音质可能略受影响
            </div>
          </div>
          <div style={styles.rateBox}>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={cfg?.volume ?? 100}
              onChange={(e) => void apply({ volume: Number(e.target.value) })}
              style={styles.range}
            />
            <span style={styles.rateValue}>{cfg?.volume ?? 100}%</span>
          </div>
        </div>

        {/* 字幕流光 */}
        <div style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.rowLabel}>字幕流光</div>
            <div style={styles.rowHint}>
              两个颜色组成渐变流光，滑块调节流动速度（越小越快）；立即生效并同步到悬浮条
            </div>
            <div style={styles.colorRow}>
              <label style={styles.colorItem}>
                <input
                  type="color"
                  value={cfg?.captionColor1 ?? '#5b8cff'}
                  onChange={(e) => applyColorDebounced('captionColor1', e.target.value)}
                  style={styles.colorInput}
                />
                颜色一
              </label>
              <label style={styles.colorItem}>
                <input
                  type="color"
                  value={cfg?.captionColor2 ?? '#a78bfa'}
                  onChange={(e) => applyColorDebounced('captionColor2', e.target.value)}
                  style={styles.colorInput}
                />
                颜色二
              </label>
              <div style={styles.rateBox}>
                <input
                  type="range"
                  min={1}
                  max={12}
                  step={0.5}
                  value={cfg?.shimmerSec ?? 4}
                  onChange={(e) => void apply({ shimmerSec: Number(e.target.value) })}
                  style={styles.range}
                />
                <span style={styles.rateValue}>{cfg?.shimmerSec ?? 4}s</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  void apply({
                    captionColor1: '#5b8cff',
                    captionColor2: '#ffffff',
                    shimmerSec: 4,
                  })
                }
                style={styles.ghostButton}
              >
                重置默认
              </button>
            </div>
          </div>
        </div>

        {/* 试听区 */}
        <div style={styles.testArea}>
          <div style={styles.testTitle}>试听</div>
          <div style={styles.chips}>
            {PRESET_TEXTS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setText(p.text)}
                style={styles.chip(text === p.text)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="也可以直接输入要试听的文字…"
            style={styles.textarea}
          />
          <div style={styles.testActions}>
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={status.kind === 'busy'}
              style={styles.primaryButton(status.kind === 'busy')}
            >
              {status.kind === 'busy' ? '合成中…' : '▶ 测试朗读'}
            </button>
            <button type="button" onClick={stopPreview} style={styles.ghostButton}>
              ■ 停止
            </button>
            {status.text ? (
              <span style={styles.status(status.kind)}>{status.text}</span>
            ) : null}
          </div>
          {floatMsg ? (
            <div
              key={floatKey}
              className="vr-float-up"
              style={{
                ...styles.floatText(floatMsg.kind === 'error'),
                pointerEvents: 'none',
              }}
            >
              {floatMsg.text}
            </div>
          ) : null}
        </div>

        {/* 二级弹窗：添加云端引擎 */}
        {engOpen ? (
          <div style={styles.modalOverlay} onClick={() => setEngOpen(false)}>
            <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={styles.modalHead}>
                <span style={styles.modalTitle}>添加云端引擎（OpenAI 兼容）</span>
                <button
                  type="button"
                  onClick={() => setEngOpen(false)}
                  style={styles.modalClose}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <div style={styles.modalHint}>
                填入厂商的 baseURL、API Key、模型 id 和自定义别名，添加后即可在
                「语音模型」下拉中选择。凭证保存在本机 engines/ 目录
              </div>
              <div style={styles.regForm}>
                <input
                  value={reg.baseUrl}
                  onChange={(e) => setReg({ ...reg, baseUrl: e.target.value })}
                  placeholder="baseURL（如 https://api.openai.com/v1）"
                  style={styles.regInput}
                />
                <input
                  value={reg.apiKey}
                  onChange={(e) => setReg({ ...reg, apiKey: e.target.value })}
                  placeholder="API Key"
                  type="password"
                  style={styles.regInput}
                />
                <input
                  value={reg.model}
                  onChange={(e) => setReg({ ...reg, model: e.target.value })}
                  placeholder="模型 id（厂商确定的模型名）"
                  style={styles.regInput}
                />
                <input
                  value={reg.alias}
                  onChange={(e) => setReg({ ...reg, alias: e.target.value })}
                  placeholder="别名（可选，默认与模型 id 一致）"
                  style={styles.regInput}
                />
                <input
                  value={reg.stylePrompt}
                  onChange={(e) => setReg({ ...reg, stylePrompt: e.target.value })}
                  placeholder="音色描述/风格指令（可选，MiMo voicedesign 需要）"
                  style={styles.regInput}
                />
              </div>
              {regMsg ? <div style={styles.modalMsg}>{regMsg}</div> : null}
              <div style={styles.modalActions}>
                <button
                  type="button"
                  onClick={() => setEngOpen(false)}
                  style={styles.ghostButton}
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={doAddEngine}
                  disabled={regBusy || !reg.baseUrl || !reg.apiKey || !reg.model}
                  style={styles.primaryButton(regBusy)}
                >
                  {regBusy ? '添加中…' : '添加'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const VR_FLOAT_CSS = `
@keyframes vr-float-up {
  0% { opacity: 0; transform: translateY(10px); }
  12% { opacity: 1; transform: translateY(0); }
  70% { opacity: 1; transform: translateY(-8px); }
  100% { opacity: 0; transform: translateY(-18px); }
}
.vr-float-up { animation: vr-float-up 2.8s ease-out forwards; }
`

// ---------------------------------------------------------------------------
// styles: theme-agnostic (inherit text color, translucent surfaces)
// ---------------------------------------------------------------------------

const styles = {
  page: {
    padding: '4px 0 24px',
    color: 'inherit',
    fontSize: 13,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    maxWidth: 720,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { fontSize: 15, fontWeight: 600 },
  badge: (saving: boolean) => ({
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid rgba(128,128,128,0.35)',
    opacity: saving ? 0.6 : 1,
  }),
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '10px 0',
    borderTop: '1px solid rgba(128,128,128,0.18)',
  },
  rowMain: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  rowLabel: { fontSize: 13, fontWeight: 500 },
  rowHint: { fontSize: 11, opacity: 0.65, lineHeight: 1.5 },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 11,
    opacity: 0.9,
  },
  switch: (on: boolean) => ({
    width: 42,
    height: 24,
    borderRadius: 999,
    border: '1px solid rgba(128,128,128,0.4)',
    background: on ? '#2563eb' : 'rgba(128,128,128,0.25)',
    position: 'relative',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 120ms ease',
  }),
  knob: (on: boolean) => ({
    position: 'absolute',
    top: 2,
    left: on ? 20 : 2,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 120ms ease',
  }),
  select: {
    minWidth: 220,
    maxWidth: 320,
    padding: '5px 8px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    flexShrink: 0,
    // Native dropdown popups use OS colors; without this they render white-on-white.
    colorScheme: 'dark',
  },
  option: {
    background: '#1f2430',
    color: '#e5e7eb',
  },
  rateBox: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  range: { width: 160 },
  rateValue: {
    minWidth: 48,
    textAlign: 'right',
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
  },
  testArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    borderRadius: 8,
    border: '1px solid rgba(128,128,128,0.22)',
    background: 'rgba(128,128,128,0.06)',
    position: 'relative',
  },
  floatText: (error: boolean) => ({
    position: 'absolute',
    right: 12,
    bottom: 40,
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 12,
    background: 'rgba(20,22,28,0.92)',
    color: error ? '#ef4444' : '#22c55e',
    border: `1px solid ${error ? 'rgba(239,68,68,0.5)' : 'rgba(34,197,94,0.5)'}`,
    zIndex: 20,
    whiteSpace: 'normal',
    maxWidth: 320,
  }),
  testTitle: { fontSize: 12, fontWeight: 600, opacity: 0.8 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chip: (active: boolean) => ({
    padding: '3px 10px',
    borderRadius: 999,
    fontSize: 11,
    cursor: 'pointer',
    border: `1px solid ${active ? '#2563eb' : 'rgba(128,128,128,0.35)'}`,
    background: active ? 'rgba(37,99,235,0.15)' : 'transparent',
    color: 'inherit',
  }),
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    padding: 8,
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  testActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  primaryButton: (busy: boolean) => ({
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid #2563eb',
    background: busy ? 'rgba(37,99,235,0.4)' : '#2563eb',
    color: '#fff',
    fontSize: 12,
    cursor: busy ? 'default' : 'pointer',
  }),
  colorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  colorItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'inherit',
    cursor: 'pointer',
  },
  colorInput: {
    width: 28,
    height: 22,
    padding: 0,
    border: '1px solid rgba(128,128,128,0.4)',
    borderRadius: 4,
    background: 'transparent',
    cursor: 'pointer',
  },
  regForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 8,
  },
  // 二级弹窗（添加云端引擎）
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
  },
  modalCard: {
    width: 420,
    maxWidth: 'calc(100vw - 48px)',
    maxHeight: 'calc(100vh - 64px)',
    overflowY: 'auto',
    background: 'rgba(28,28,32,0.98)',
    color: '#e6e6e6',
    border: '1px solid rgba(128,128,128,0.3)',
    borderRadius: 10,
    padding: '14px 16px 16px',
    boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
  },
  modalHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalTitle: { fontSize: 14, fontWeight: 600 },
  modalClose: {
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    fontSize: 18,
    lineHeight: 1,
    cursor: 'pointer',
    padding: '2px 6px',
    opacity: 0.7,
  },
  modalHint: {
    fontSize: 12,
    opacity: 0.65,
    lineHeight: 1.5,
    marginTop: 6,
  },
  modalMsg: {
    fontSize: 12,
    marginTop: 8,
    opacity: 0.9,
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  regInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  ghostButton: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  },
  status: (kind: string) => ({
    fontSize: 11,
    opacity: 0.85,
    color: kind === 'error' ? '#ef4444' : kind === 'ok' ? '#22c55e' : 'inherit',
  }),
  dot: (color: string) => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    marginRight: 6,
    verticalAlign: 'middle',
  }),
  modelButtons: { display: 'flex', gap: 8, flexShrink: 0 },
  error: { fontSize: 12, color: '#ef4444' },
  hint: { fontSize: 11, opacity: 0.7 },
} as const
