import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
const repo = process.cwd(), fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'caogen-handoff-integrated-')))
try {
  const stub = path.join(fixture, 'electron.ts'), bundle = path.join(fixture, 'fixture.cjs')
  writeFileSync(stub, `export const app={getPath:()=>${JSON.stringify(fixture)},getVersion:()=> '0.1.9',isPackaged:false}; export const safeStorage={isEncryptionAvailable:()=>false}; export const shell={}; export const dialog={}; export const BrowserWindow=class{}; export const ipcMain={handle(){}}; export const desktopCapturer={}; export const systemPreferences={}; export const WebContentsView=class{}; export const Notification=class{}; export const powerSaveBlocker={};`)
  buildSync({ entryPoints: [path.join(repo, 'scripts/task-handoff-integrated-entry.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(repo,'package.json')).href) }, alias: { electron: stub } })
  const output = execFileSync(process.execPath, [bundle, fixture], { cwd: repo, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repo, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] })
  process.stdout.write(output)
} catch(error) { console.error(String(error?.stderr || error)); process.exitCode = 1 }
finally { rmSync(fixture, { recursive: true, force: true }) }
