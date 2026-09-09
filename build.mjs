// dsh-voice-reader build: esbuild-based, mirroring the artifact shape that
// DeepSeek Harness plugins expect (see @haoku123/dsh-voice build.mjs):
//   - host half  → plain ESM cordis plugin  (lib/index.js)
//   - client half → CJS module-loader closure artifact (lib/client.js)
//   - segmenter   → standalone ESM for pure unit tests (lib/segmenter.js)

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

const PKG_ID = 'dsh-voice-reader'

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

mkdirSync('lib', { recursive: true })

// --- host half: plain ESM cordis plugin; runtime deps stay external ---
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    'msedge-tts',
    'node:*',
  ],
  logLevel: 'info',
})

// --- client half: module-loader closure artifact ---
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// --- standalone builds for the pure unit tests ---
for (const entry of ['segmenter', 'settings-store']) {
  await build({
    entryPoints: [`src/${entry}.ts`],
    outfile: `lib/${entry}.js`,
    bundle: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
}

console.log('[dsh-voice-reader] build done: lib/index.js (host) + lib/client.js (browser)')
