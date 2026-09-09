// SpeakQueue pre-synthesized audio passthrough (thinking phrases) tests.
import assert from 'node:assert/strict'
import { SpeakQueue } from '../src/speak-queue.ts'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fake provider: records calls, optional artificial synthesis delay.
function makeProvider(delayMs = 0) {
  const calls = []
  return {
    calls,
    id: 'fake',
    label: 'fake',
    streaming: false,
    outputFormat: 'audio/mpeg',
    async synthesize(text) {
      calls.push(text)
      if (delayMs) await sleep(delayMs)
      return Buffer.from(`tts:${text}`)
    },
    async listVoices() {
      return []
    },
    async isAvailable() {
      return true
    },
    async dispose() {},
  }
}

async function testEnqueueAudioPassthrough() {
  const provider = makeProvider()
  const frames = []
  const q = new SpeakQueue({ resolveProvider: () => provider })
  q.subscribe((f) => frames.push(f))
  const raw = Buffer.from('cached-bytes')
  q.enqueueAudio('s1', '让子弹飞一会', raw, 'audio/mpeg')
  await sleep(30)
  assert.equal(frames.length, 1, 'one frame broadcast')
  assert.equal(frames[0].text, '让子弹飞一会')
  assert.equal(frames[0].audio, raw.toString('base64'), 'audio passed through verbatim')
  assert.equal(frames[0].mime, 'audio/mpeg')
  assert.equal(provider.calls.length, 0, 'TTS engine NOT called for cached audio')
  console.log('[ok] enqueueAudio passthrough (no TTS call)')
}

async function testMixedQueue() {
  // Pre-synthesized + normal text sentences share one ordered queue.
  const provider = makeProvider()
  const frames = []
  const q = new SpeakQueue({ resolveProvider: () => provider })
  q.subscribe((f) => frames.push(f))
  q.enqueueAudio('s1', '思考中…', Buffer.from('A'), 'audio/mpeg')
  q.enqueue('s1', '正文第一句')
  await sleep(30)
  assert.equal(frames.length, 2, 'both frames broadcast in order')
  assert.equal(frames[0].text, '思考中…')
  assert.equal(frames[1].text, '正文第一句')
  assert.equal(frames[1].audio, Buffer.from('tts:正文第一句').toString('base64'))
  assert.equal(provider.calls.length, 1, 'only the text sentence hits TTS')
  console.log('[ok] mixed queue: cached phrase first, then synthesized text')
}

async function testIsIdle() {
  const provider = makeProvider(50)
  const q = new SpeakQueue({ resolveProvider: () => provider })
  assert.equal(q.isIdle('sx'), true, 'unknown session is idle')
  q.enqueue('sx', '慢慢合成的一句')
  await sleep(10)
  assert.equal(q.isIdle('sx'), false, 'busy synthesizing → not idle')
  await sleep(80)
  assert.equal(q.isIdle('sx'), true, 'drained → idle again')
  console.log('[ok] isIdle tracks pending + in-flight synthesis')
}

async function testOnTextEnqueue() {
  // The waiting-phrase loop stops on the first TEXT enqueue; pre-synthesized
  // audio (enqueueAudio) must NOT trigger it.
  const provider = makeProvider()
  const stops = []
  const q = new SpeakQueue({
    resolveProvider: () => provider,
    onTextEnqueue: (sessionId) => stops.push(sessionId),
  })
  q.enqueueAudio('s1', '思考中…', Buffer.from('A'), 'audio/mpeg')
  await sleep(20)
  assert.equal(stops.length, 0, 'cached phrase enqueue does not stop the loop')
  q.enqueue('s1', '正文第一句')
  assert.deepEqual(stops, ['s1'], 'text enqueue stops the loop immediately')
  console.log('[ok] onTextEnqueue fires for text only (not for cached phrases)')
}

await testEnqueueAudioPassthrough()
await testMixedQueue()
await testIsIdle()
await testOnTextEnqueue()
console.log('[thinking-queue] all tests passed')
