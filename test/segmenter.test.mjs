// Pure unit tests for the sentence segmenter (no network, no DSH host).
// Run: npm test  (needs `npm run build` first to emit lib/segmenter.js)

import assert from 'node:assert/strict'
import { SentenceSegmenter, splitSentences, plainText } from '../lib/segmenter.js'

// --- splitSentences ---

{
  const { sentences, tail } = splitSentences('你好。这是第二句！还没说完')
  assert.deepEqual(sentences, ['你好。', '这是第二句！'])
  assert.equal(tail, '还没说完')
}

{
  // English: lone period only terminates before whitespace / EOL
  const { sentences, tail } = splitSentences('The price is 3.14 dollars. And Pi is 3.14')
  assert.deepEqual(sentences, ['The price is 3.14 dollars.'])
  assert.equal(tail, ' And Pi is 3.14')
}

{
  // newline is a boundary too
  const { sentences } = splitSentences('第一行\n第二行')
  assert.deepEqual(sentences, ['第一行\n'])
  assert.equal(splitSentences('第一行\n第二行').tail, '第二行')
}

// --- plainText: markdown noise is stripped before synthesis ---

{
  const t = plainText('**加粗** 和 `代码` 和 [链接](https://x.com) 结尾')
  assert.ok(!t.includes('**'))
  assert.ok(!t.includes('https://x.com'))
  assert.ok(t.includes('加粗'))
  assert.ok(t.includes('链接'))
}

// --- SentenceSegmenter streaming behavior ---

{
  const seg = new SentenceSegmenter()
  const a = seg.feed('这是第一句。这是第二')
  assert.deepEqual(a, ['这是第一句。'])
  const b = seg.feed('句，还没完。以及第三句。')
  assert.deepEqual(b, ['这是第二句，还没完。', '以及第三句。'])
  const c = seg.flush()
  assert.deepEqual(c, [])
}

{
  const seg = new SentenceSegmenter()
  assert.deepEqual(seg.feed('无标点的一段长文本'), [])
  // long markdown wall forces a flush at a comma/space boundary
  const wall = '无'.repeat(300)
  const out = seg.feed(wall)
  assert.ok(out.length === 1)
  assert.ok(out[0].length > 0)
}

{
  // trailing sentence without punctuation is emitted on flush
  const seg = new SentenceSegmenter()
  seg.feed('一句话说了一半')
  assert.deepEqual(seg.flush(), ['一句话说了一半'])
  // empty flush
  assert.deepEqual(seg.flush(), [])
}

console.log('[segmenter] all tests passed')
