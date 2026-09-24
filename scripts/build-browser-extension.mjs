import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const manifest = JSON.parse(readFileSync('resources/browser-extension/manifest.json', 'utf8'))
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map(value => String.fromCharCode(97 + parseInt(value, 16))).join('')
if (!readFileSync('src/shared/browser-extension-package.ts', 'utf8').includes(`'${id}'`)) throw new Error('Extension manifest public identity does not match the UI package ID')
await build({ entryPoints: ['extensions/browser/service-worker.js'], outfile: 'resources/browser-extension/service-worker.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome118', minify: false, legalComments: 'none' })
console.log('Built local EastGenesis Browser Bridge (Manifest V3).')
