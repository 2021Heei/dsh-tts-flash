# dsh-tts-flash

https://github.com/2021Heei/dsh-tts-flash/raw/main/demo.mp4

给 DeepSeek Harness（DSH）桌面端做的 **LLM 回复语音朗读插件**：AI 边流式输出，本地边把句子合成语音播放，随读随停；AI 思考等待期间还有"文字+语音"双通道的趣味短语反馈。

- **零配置可用**：内置微软 edge-tts，能联网就能用（几十种音色）
- **云端引擎即插即用**：任何 OpenAI 兼容 TTS 服务（OpenAI / 小米 MiMo / 硅基流动…）在设置面板里填 baseURL + API Key + 模型 id 即可添加，双协议自适应
- **等待期语音**：模型思考时浮条轮换趣味短语并同步朗读（"让子弹飞一会…"），等待不再干瞪眼

---

## 功能总览

| 模块 | 说明 |
|---|---|
| 无损流式朗读 | `llm/stream` 旁路 tap → 中英日分句 → 短句合并 → 串行合成 → SSE 推送；队列带背压上限，长回复自动追赶 |
| 多引擎 | edge-tts（内置）+ OpenAI 兼容云端 TTS（双协议自适应：`/audio/speech` → `chat/completions`） |
| 引擎即插即用 | 设置面板二级弹窗添加，或往 `~/.dsh/tts-flash/engines/` 放一个 JSON 声明自动出现 |
| 等待期语音体系 | AI 思考时轮换 5 条内置趣味短语（**文字+语音同步**，host 统一驱动）；语音按「模型-音色」前缀缓存只生成一次；等待语音模型可独立选择（默认 Edge 小艺） |
| 语音设置面板 | 朗读开关 / 语音模型 / 音量 / 语速 / 字幕流光与字号 / 云端引擎管理（二级弹窗）/ 试听区，全部实时生效 |
| 朗读悬浮条 | 纯文字胶囊，可拖动、位置记忆（相对聊天输入框锚点，窗口缩放自动适应）、长句单程滚动字幕（滚动时长 = 真实音频时长） |
| 持久化 | 运行时设置独立 JSON 文件，重启、重装插件均不丢失 |

## 安装

```sh
npm install && node build.mjs && npm test   # 构建 + 单测
npm pack                                    # → dsh-tts-flash-0.1.0.tgz
# 用 DSH 的插件安装流程注册该 tgz（cordis.patch.yml 会把 host 引擎 + 客户端浮条注入 profile）
```

日常迭代最快路径：把 `lib/*.js` 覆盖复制到 `~/.dsh/profiles/desktop/node_modules/dsh-tts-flash/lib/` 再重启应用。

## 使用

### 引擎

- **Edge TTS（默认）**：零配置，音色几十种（晓晓/云希/小艺…），「语音模型」下拉选择即可
- **添加云端引擎**：设置面板「云端引擎」按钮 → 弹窗填 baseURL、API Key、模型 id（别名可选，默认与模型 id 一致）→ 点「添加」。模型 id 必须与厂商文档完全一致（如 MiMo 全小写）
- 也可以不经过面板：往 `~/.dsh/tts-flash/engines/` 放一个 JSON 声明：

```json
{
  "id": "my-engine",
  "label": "我的引擎",
  "kind": "openai",
  "url": "https://api.example.com/v1",
  "apiKey": "sk-...",
  "model": "tts-model-id",
  "stylePrompt": "可选：音色描述/风格指令（voicedesign 类模型需要）"
}
```

- API Key 保存在本机 `~/.dsh/tts-flash/engines/`（单用户本机场景）；请勿把该目录内容分享给他人

### 等待期语音

AI 思考（已开始生成但还没有音频）时，浮条每 2.6~3.5 秒轮换一条短语并**同步朗读**（文字与语音由 host 统一驱动，显示什么就说什么）：

- 语音文件缓存在 `~/.dsh/tts-flash/cache/thinking/<引擎id>-<音色>.p<序号>.mp3`，首次用到自动补齐整池，之后直接回放
- 「等待期语音模型」可独立选择发声引擎（默认 Edge 小艺 zh-CN-XiaoyiNeural）；「批量生成语音」可预生成；「清理语音文件」删除全部
- 短语池在 `src/thinking-phrases.ts`（5 条），host/client 共享，改完短语后请重新生成音频文件
- 第一句正文出现时短语循环立即停止，无缝切换为正文朗读

### 语音设置面板

| 控件 | 行为 |
|---|---|
| 朗读开关 | 与朗读管线实时同步（SSE 广播） |
| 语音模型 | 自动检测（Edge）+ 各引擎，实时探测可用性 |
| 人声 | 跟随模型刷新（edge 拉微软实时列表） |
| 语速 | -75% ~ +200%；edge 服务端封顶 +100%，MiMo 式引擎翻译为自然语言控速指令 |
| 音量 | 0% ~ 200%，≤100% 播放端衰减，>100% edge 走 SSML 增益 |
| 字幕流光/字号 | 两个渐变色 + 流光速度 + 字号（10~30px），即时同步 |
| 云端引擎 | 二级弹窗添加/说明；选中引擎后可编辑音色描述、删除引擎 |
| 等待期语音 | 独立发声引擎选择 + 批量生成/清理 |
| 悬浮条位置 | 可拖动 + 「设为默认」/「重置」 |
| 试听区 | 预设文案 + 自由输入 + 测试朗读 |

## 架构

```
src/
  index.ts                # host 入口：HTTP 路由 + llm/stream tap + 等待短语循环
  provider.ts             # TtsProvider 接口
  speak-queue.ts          # 串行合成队列：epoch 取消 + 预合成音频直通 + onTextEnqueue 钩子
  segmenter.ts            # 中英日分句 + markdown/emoji 清洗（复用 dsh-voice，MIT）
  thinking-phrases.ts     # 等待短语池（host/client 共享，文本↔音频 1:1）
  settings-store.ts       # 设置持久化 + 引擎声明发现
  providers/
    edge-tts.provider.ts  # 微软 Edge 云端语音
    openai-tts.provider.ts# OpenAI 兼容云端 TTS（双协议自适应）
  client.tsx              # shell.overlay 朗读浮条
  settings-section.tsx    # settings.section 语音设置面板（含添加引擎二级弹窗）
  client-api.ts           # 面板 ↔ host fetch 封装
build.mjs                 # esbuild：lib/index.js（host）+ lib/client.js（浏览器）
```

引擎接口（换/加引擎 = 新增一个 provider 文件，核心零改动）：

```ts
interface TtsProvider {
  id: string; label: string; streaming: boolean
  synthesize(text, opts?): Promise<Buffer>   // 一句 → 音频字节
  listVoices(): Promise<VoiceInfo[]>
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
}
```

### HTTP API（均在 `/dsh-tts-flash` 下）

```
GET  /config            → 设置快照 + engines[] + voices[]
POST /config            → 设置补丁（enabled/engine/voice/rate/thinkingEngine/…/resetPos）
POST /preview           → { text, engine?, voice?, rate? } → { audio: base64, mime, … }
POST /engines           → 添加云端引擎 { baseUrl, apiKey, model, alias?, stylePrompt? }
POST /engines/style     → 编辑音色描述/风格指令
POST /engines/delete    → 删除引擎
POST /thinking/generate → 批量生成等待语音文件
POST /thinking/clear    → 清理等待语音文件
POST /cancel            → { sessionId } 停止该会话朗读
GET  /stream            → SSE：audio 帧 + config/status 广播
```

## 已知限制

- 未点开过页面前浏览器可能拦截有声自动播放（DSH 内发过一条消息后即解除）。
- edge-tts 是微软未公开接口：无 SLA，断网即不可用；语速服务端封顶 +100%。
- client 的 `BASE` 与 host `basePath` 默认值绑定（`/dsh-tts-flash`），改 host 配置需同步 client。
- 桌面端 web server 只放行 DSH 渲染进程的请求（外部 curl 一律 forbidden，属正常）。

## License

MIT
