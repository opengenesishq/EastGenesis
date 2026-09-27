#!/usr/bin/env node
/**
 * Packaged smoke evidence for the 0913 refactor plan.
 *
 * This gate intentionally proves only a local packaged preview startup. It never
 * claims signing, notarization, publishing, or formal release readiness.
 *
 * Examples:
 *   node scripts/packaged-preview-smoke-required.mjs --source-only
 *   node scripts/packaged-preview-smoke-required.mjs --artifact dist/mac/EastGenesis.app
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const packageJsonPath = path.join(repoRoot, 'package.json')
const packageJson = readJson(packageJsonPath)
const args = parseArgs(process.argv.slice(2))
const channel = args.channel || process.env.CAOGEN_PACKAGE_CHANNEL || 'unsigned-preview'
const outputDir = path.join(repoRoot, 'test-results', 'packaged-preview-smoke')
const outputPath = path.join(outputDir, 'latest.json')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const checks = []
const warnings = []
const report = {
  schemaVersion: 1,
  kind: 'caogen.packaged-preview-smoke-report',
  runId,
  generatedAt: new Date().toISOString(),
  status: 'running',
  channel,
  claimScope: 'local-unsigned-preview',
  releaseClaim: false,
  signingVerified: false,
  notarizationVerified: false,
  published: false,
  evidenceStrength: 'source-contract-only',
  packageVersion: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  artifact: null,
  checks,
  warnings
}

function parseArgs(argv) {
  const parsed = { sourceOnly: false, launch: false, artifact: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--source-only') parsed.sourceOnly = true
    else if (value === '--launch') parsed.launch = true
    else if (value === '--artifact') parsed.artifact = argv[++index]
    else if (value === '--channel') parsed.channel = argv[++index]
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node scripts/packaged-preview-smoke-required.mjs [--source-only] [--artifact PATH] [--launch] [--channel unsigned-preview|release]')
      process.exit(0)
    } else throw new Error(`unknown option: ${value}`)
  }
  const selectedChannel = parsed.channel || process.env.CAOGEN_PACKAGE_CHANNEL || 'unsigned-preview'
  if (selectedChannel !== 'unsigned-preview') {
    throw new Error('packaged preview smoke only accepts unsigned-preview; use the release audit and packaged-app smoke gates for release evidence')
  }
  return parsed
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    checks.push({ name, status: 'passed', detail: detail || '' })
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    checks.push({ name, status: 'failed', detail })
    console.error(`[FAIL] ${name} — ${detail}`)
  }
}

function resolveArtifact() {
  if (args.artifact) return path.resolve(repoRoot, args.artifact)
  const candidates = []
  const distDir = path.join(repoRoot, 'dist')
  if (existsSync(distDir)) {
    for (const candidate of [
      path.join(distDir, 'mac', `${packageJson.productName || 'EastGenesis'}.app`),
      path.join(distDir, 'mac-arm64', `${packageJson.productName || 'EastGenesis'}.app`),
      path.join(distDir, 'mac-x64', `${packageJson.productName || 'EastGenesis'}.app`),
      path.join(distDir, 'win-unpacked', `${packageJson.productName || 'EastGenesis'}.exe`),
      path.join(distDir, 'linux-unpacked', packageJson.productName || 'EastGenesis')
    ]) candidates.push(candidate)
    const names = safeReadDir(distDir)
    for (const name of names) {
      if (/\.app$/i.test(name) || /-unpacked$/i.test(name) || /unsigned-preview\.(exe|dmg|zip)$/i.test(name)) {
        candidates.push(path.join(distDir, name))
      }
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) || null
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}


function classifyArtifact(artifactPath) {
  const basename = path.basename(artifactPath)
  const stat = statSync(artifactPath)
  if (stat.isDirectory() && /\.app$/i.test(basename)) return { kind: 'mac-app', path: artifactPath, launchable: true }
  if (stat.isDirectory() && /-unpacked$/i.test(basename)) {
    const executable = process.platform === 'win32'
      ? path.join(artifactPath, `${packageJson.productName || 'EastGenesis'}.exe`)
      : process.platform === 'darwin'
        ? path.join(artifactPath, `${packageJson.productName || 'EastGenesis'}.app`, 'Contents', 'MacOS', packageJson.productName || 'EastGenesis')
        : path.join(artifactPath, packageJson.productName || 'EastGenesis')
    return { kind: 'unpacked-directory', path: artifactPath, executable, launchable: existsSync(executable) }
  }
  if (/\.exe$/i.test(basename)) return { kind: 'windows-installer-or-executable', path: artifactPath, launchable: false }
  if (/\.(dmg|zip|AppImage)$/i.test(basename)) return { kind: path.extname(basename).slice(1), path: artifactPath, launchable: false }
  return { kind: 'unknown', path: artifactPath, launchable: false }
}

function assertPreviewArtifactIdentity(artifact) {
  // A preview artifact must carry its channel in the filename. This prevents a
  // generic installer/app from being silently reported as the unsigned preview.
  const basename = path.basename(artifact.path)
  if (artifact.kind === 'mac-app' || artifact.kind === 'unpacked-directory') return
  assert(/unsigned-preview/i.test(basename), `preview artifact filename must contain unsigned-preview: ${basename}`)
}

function appExecutable(artifact) {
  if (artifact.kind === 'mac-app') return path.join(artifact.path, 'Contents', 'MacOS', packageJson.productName || 'EastGenesis')
  return artifact.executable
}

function inspectMacMetadata(artifact) {
  if (artifact.kind !== 'mac-app') return null
  const infoPath = path.join(artifact.path, 'Contents', 'Info.plist')
  if (!existsSync(infoPath)) return { infoPlist: false }
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', infoPath], { encoding: 'utf8' })
    const info = JSON.parse(json)
    return { infoPlist: true, bundleIdentifier: info.CFBundleIdentifier || null, executable: info.CFBundleExecutable || null }
  } catch {
    return { infoPlist: true, parseable: false }
  }
}

function inspectUnpackedLayout(artifact) {
  const root = artifact.kind === 'mac-app' ? path.join(artifact.path, 'Contents', 'Resources') : artifact.path
  const appAsar = path.join(root, 'app.asar')
  const appDir = path.join(root, 'app')
  const packagePath = existsSync(appDir) ? path.join(appDir, 'package.json') : null
  return {
    resourcesRoot: root,
    appAsar: existsSync(appAsar),
    appDirectory: existsSync(appDir),
    appPackageJson: packagePath ? existsSync(packagePath) : false,
    nodePtyUnpacked: existsSync(path.join(root, 'app.asar.unpacked', 'node_modules', 'node-pty')) || existsSync(path.join(root, 'app', 'node_modules', 'node-pty'))
  }
}

async function launchSmoke(artifact) {
  const executable = appExecutable(artifact)
  assert(executable && existsSync(executable), `launch executable missing: ${executable || '(unknown)'}`)
  const userData = await mkdtemp(path.join(realpathSync(tmpdir()), 'caogen-packaged-smoke-'))
  const stdout = []
  const stderr = []
  const child = spawn(executable, ['--user-data-dir', userData], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userData,
      CAOGEN_MEMORY_DIR: path.join(userData, 'memory'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      APPLE_API_KEY: '',
      APPLE_API_KEY_ID: '',
      APPLE_API_ISSUER: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk) => stdout.push(chunk.toString()))
  child.stderr?.on('data', (chunk) => stderr.push(chunk.toString()))
  const startedAt = Date.now()
  const terminateProcessTree = () => {
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }, 250)
      return
    }
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, 250)
  }
  const exit = await new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.once('error', (error) => finish({ error: error.message }))
    child.once('exit', (code, signal) => finish({ code, signal }))
    setTimeout(() => {
      if (!settled) {
        terminateProcessTree()
        finish({ aliveMs: Date.now() - startedAt, code: null, signal: 'SIGTERM' })
      }
    }, 4000)
  })
  await removeTempDirectory(userData)
  if (exit.error) throw new Error(exit.error)
  if (exit.code !== null && exit.code !== 0) throw new Error(`packaged process exited early code=${exit.code} signal=${exit.signal || 'none'} stderr=${stderr.join('').slice(-800)}`)
  return { executable, elapsedMs: Date.now() - startedAt, exit, stdoutTail: stdout.join('').slice(-500), stderrTail: stderr.join('').slice(-800) }
}

async function removeTempDirectory(directory) {
  // Electron helper processes can release files a few milliseconds after the
  // top-level process is killed. Retry only the transient directory-not-empty
  // case so a successful startup is not reported as a smoke failure.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' || attempt === 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

try {
  await check('package metadata declares an Electron main entry', () => {
    assert(packageJson.main === './out/main/index.js', `unexpected package.main=${packageJson.main}`)
    assert(packageJson.build?.appId, 'build.appId missing')
    assert(packageJson.build?.productName, 'build.productName missing')
    return `${packageJson.build.productName} ${packageJson.version}`
  })
  await check('builder includes compiled app and unpacks native terminal module', () => {
    const files = packageJson.build?.files || []
    const unpack = packageJson.build?.asarUnpack || []
    assert(files.some((entry) => String(entry) === 'out/**/*'), 'build.files must include out/**/*')
    assert(unpack.some((entry) => String(entry).includes('node-pty')), 'build.asarUnpack must include node-pty')
    return 'out/**/* + node-pty asarUnpack'
  })
  await check('built source inputs exist before packaged launch', () => {
    for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      assert(existsSync(path.join(repoRoot, entry)), `missing ${entry}; run npm run build first`)
    }
    return 'main/preload/renderer present'
  })
  await check('unsigned preview policy is explicit and release remains separate', () => {
    const previewConfigPath = path.join(repoRoot, 'electron-builder.windows-preview.cjs')
    const releaseConfigPath = path.join(repoRoot, 'electron-builder.release.cjs')
    assert(existsSync(previewConfigPath), 'Windows preview builder config is required')
    assert(existsSync(releaseConfigPath), 'release builder config is required to prove channel separation')
    const previewConfig = readFileSync(previewConfigPath, 'utf8')
    const releaseConfig = readFileSync(releaseConfigPath, 'utf8')
    assert(previewConfig.includes('forceCodeSigning: false'), 'preview config must disable forced signing')
    assert(previewConfig.includes('publish: null'), 'preview config must disable publishing')
    assert(previewConfig.includes('unsigned-preview'), 'preview artifact name must be visibly unsigned-preview')
    assert(releaseConfig.includes('forceCodeSigning: true'), 'release config must require code signing')
    assert(releaseConfig.includes('notarize: true'), 'release macOS config must require notarization')
    assert(!previewConfig.includes('forceCodeSigning: true'), 'preview config must never opt into forced signing')
    return 'preview unsigned/publish-disabled; release signing/notarization-required'
  })

  const artifactPath = resolveArtifact()
  if (!args.sourceOnly) {
    await check('packaged artifact is present', () => {
      assert(artifactPath, 'no packaged artifact found; pass --artifact or build an unpacked preview first')
      assert(existsSync(artifactPath), `artifact missing: ${artifactPath}`)
      const artifact = classifyArtifact(artifactPath)
      assertPreviewArtifactIdentity(artifact)
      report.artifact = { ...artifact, metadata: inspectMacMetadata(artifact), layout: inspectUnpackedLayout(artifact) }
      return `${artifact.kind}: ${artifact.path}`
    })
    if (report.artifact) {
      await check('packaged resources contain an Electron app payload', () => {
        const layout = report.artifact.layout
        assert(layout.appAsar || layout.appDirectory, 'resources must contain app.asar or app directory')
        return layout.appAsar ? 'app.asar present' : 'app directory present'
      })
      if (args.launch || report.artifact.launchable) {
        await check('packaged preview stays alive during launch smoke', async () => {
          const result = await launchSmoke(report.artifact)
          report.artifact.launch = result
          report.evidenceStrength = 'artifact-startup-observed'
          return `${result.executable} alive ${result.elapsedMs}ms`
        })
      } else warnings.push('artifact format is not directly launchable by this host; startup was not attempted')
    }
  } else {
    warnings.push('source-only mode: no packaged artifact or launch claim was attempted')
  }

  report.status = checks.some((item) => item.status === 'failed') ? 'failed' : args.sourceOnly ? 'source-contract-passed' : 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`[FAIL] packaged preview smoke: ${report.error}`)
}

mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`packaged preview smoke: ${report.status}`)
console.log(`report: ${outputPath}`)
if (report.status === 'failed') process.exitCode = 1
