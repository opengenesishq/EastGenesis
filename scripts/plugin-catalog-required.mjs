import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
const repo = process.cwd(), root = realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-plugin-catalog-')))
try {
  const stub = path.join(root, 'electron.ts'), bundle = path.join(root, 'fixture.cjs')
  writeFileSync(stub, `export const app={getPath:()=>${JSON.stringify(root)},getVersion:()=> '0.1.9',isPackaged:false}; export const safeStorage={isEncryptionAvailable:()=>false}; export const shell={}; export const dialog={}; export const BrowserWindow=class{}; export const ipcMain={handle(){}}; export const desktopCapturer={}; export const systemPreferences={}; export const WebContentsView=class{}; export const Notification=class{}; export const powerSaveBlocker={};`)
  buildSync({ entryPoints: [path.join(repo, 'scripts/plugin-catalog-entry.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', alias: { electron: stub }, define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(repo, 'package.json')).href) } })
  process.stdout.write(execFileSync(process.execPath, [bundle, root], { cwd: repo, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repo, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] }))
} catch (error) { console.error(String(error?.stdout || '') + String(error?.stderr || error)); process.exitCode = 1 }
finally { rmSync(root, { recursive: true, force: true }) }
