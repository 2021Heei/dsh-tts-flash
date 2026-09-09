/**
 * settings-store unit tests.
 *
 * The store anchors its paths to os.homedir(), so the suite points HOME at a
 * throwaway temp dir before importing the module — nothing touches the real
 * ~/.dsh/tts-flash directory.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-vr-store-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

const store = await import('../lib/settings-store.js')

let failed = 0
function check(label, cond, extra) {
  if (cond) {
    console.log(`[ok]   ${label}`)
  } else {
    failed++
    console.log(`[FAIL] ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

try {
  // 1. no file yet → defaults
  let s = store.loadSettings()
  check('defaults', s.enabled === true && s.engine === 'auto' && s.voice === '' && s.rate === 0, JSON.stringify(s))

  // 2. save → load roundtrip
  store.saveSettings({ enabled: false, engine: 'edge-tts', voice: 'zh-CN-YunxiNeural', rate: 25 })
  s = store.loadSettings()
  check(
    'roundtrip',
    s.enabled === false && s.engine === 'edge-tts' && s.voice === 'zh-CN-YunxiNeural' && s.rate === 25,
    JSON.stringify(s),
  )
  check('hasSettingsFile true', store.hasSettingsFile())

  // 3. partial patch keeps the rest
  store.saveSettings({ rate: 60 })
  s = store.loadSettings()
  check('partial patch', s.rate === 60 && s.voice === 'zh-CN-YunxiNeural' && s.enabled === false, JSON.stringify(s))

  // 4. rate clamping: -75..200
  store.saveSettings({ rate: 500 })
  s = store.loadSettings()
  check('rate clamps high', s.rate === 200, String(s.rate))
  store.saveSettings({ rate: -900 })
  s = store.loadSettings()
  check('rate clamps low', s.rate === -75, String(s.rate))

  // 5. corrupt file → clean defaults, no throw
  writeFileSync(store.SETTINGS_FILE, '{ not json !!', 'utf8')
  s = store.loadSettings()
  check('corrupt file falls back to defaults', s.rate === 0 && s.enabled === true && s.engine === 'auto', JSON.stringify(s))

  // 6. engine declarations: drop-in discovery + malformed skip
  const d = store.ENGINES_DIR
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'gpt-sovits.json'), JSON.stringify({ id: 'gpt-sovits', label: 'GPT-SoVITS', url: 'http://127.0.0.1:9880' }), 'utf8')
  writeFileSync(join(d, 'bad.json'), '{ nope', 'utf8')
  writeFileSync(join(d, 'note.txt'), 'ignored', 'utf8')
  const decls = store.loadEngineDeclarations()
  check('discovers drop-in engine', decls.length === 1 && decls[0].id === 'gpt-sovits' && decls[0].url === 'http://127.0.0.1:9880', JSON.stringify(decls))

  // 7. saveEngineDeclaration roundtrip
  store.saveEngineDeclaration({ id: 'chattts-x', label: 'X', url: 'http://127.0.0.1:5001' })
  const decls2 = store.loadEngineDeclarations()
  check('declaration write+read', decls2.some((x) => x.id === 'chattts-x'), JSON.stringify(decls2))
} finally {
  rmSync(fakeHome, { recursive: true, force: true })
}

if (failed) {
  console.error(`[settings-store] ${failed} test(s) FAILED`)
  process.exit(1)
}
console.log('[settings-store] all tests passed')
