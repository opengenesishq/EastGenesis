#!/usr/bin/env node
/**
 * PalaceScene local 3D asset / packaged renderer capability gate.
 *
 * This is intentionally offline and provider-free. It proves that the local
 * Palace GLBs used by the existing R3F renderer are valid glTF 2.0 binaries,
 * that the renderer keeps an explicit loader/error boundary, and that the
 * current renderer build carries the exact same bytes. It does not claim that
 * a human has interacted with a real 3D scene or that a signed package is
 * release-ready.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const sourceRoot = path.join(repoRoot, 'src', 'renderer', 'src', 'assets', 'palace')
const outRoot = path.join(repoRoot, 'out', 'renderer', 'assets')
const reportDir = path.join(repoRoot, 'test-results', 'palace-scene-packaged-runtime')
const reportPath = path.join(reportDir, 'latest.json')
const checks = []
const gltfLoaderModule = import('three/examples/jsm/loaders/GLTFLoader.js')

function check(id, condition, detail) {
  checks.push({ id, status: condition ? 'passed' : 'failed', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${id}${detail ? ` — ${detail}` : ''}`)
  if (!condition) throw new Error(detail || id)
}

function sha256(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function parseGlb(filePath) {
  const bytes = readFileSync(filePath)
  check(`asset:${path.basename(filePath)}:exists`, bytes.length >= 20, `${path.relative(repoRoot, filePath)} is at least a GLB header`)
  check(`asset:${path.basename(filePath)}:magic`, bytes.subarray(0, 4).toString('ascii') === 'glTF', 'GLB magic is glTF')
  check(`asset:${path.basename(filePath)}:version`, bytes.readUInt32LE(4) === 2, 'GLB version is 2')
  check(`asset:${path.basename(filePath)}:declared-length`, bytes.readUInt32LE(8) === bytes.length, 'GLB declared length matches file bytes')
  const jsonLength = bytes.readUInt32LE(12)
  const jsonType = bytes.readUInt32LE(16)
  check(`asset:${path.basename(filePath)}:json-chunk`, jsonType === 0x4e4f534a && jsonLength > 0 && 20 + jsonLength <= bytes.length, 'first chunk is a bounded JSON chunk')
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim())
  check(`asset:${path.basename(filePath)}:gltf-version`, json?.asset?.version === '2.0', 'JSON declares glTF 2.0')
  check(`asset:${path.basename(filePath)}:scene-geometry`, Array.isArray(json.scenes) && json.scenes.length > 0 && (json.nodes?.length ?? 0) > 0 && (json.meshes?.length ?? 0) > 0, `scene=${json.scenes?.length ?? 0}, nodes=${json.nodes?.length ?? 0}, meshes=${json.meshes?.length ?? 0}`)
  return { bytes, digest: sha256(bytes), bytesLength: bytes.length, json }
}

async function parseWithGltfLoader(filePath) {
  const { GLTFLoader } = await gltfLoaderModule
  const bytes = readFileSync(filePath)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  await new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, '', (gltf) => {
      try {
        check(`loader-parse:${path.basename(filePath)}`, Boolean(gltf.scene && gltf.scene.children.length > 0), `GLTFLoader parsed ${gltf.scene.children.length} root children without network`) 
        resolve()
      } catch (error) {
        reject(error)
      }
    }, reject)
  })
}

function writeReport(status, error) {
  mkdirSync(reportDir, { recursive: true })
  const report = {
    schemaVersion: 1,
    kind: 'caogen.palace-scene-packaged-runtime-report',
    generatedAt: new Date().toISOString(),
    status,
    evidenceStrength: 'local-built-renderer-assets',
    releaseClaim: false,
    providerCalls: 0,
    human3DInteraction: false,
    checks,
    ...(error ? { error } : {})
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`report: ${reportPath}`)
}

function builtAssetCandidates(names, name) {
  const stem = name.slice(0, -'.glb'.length)
  return names.filter((candidate) => candidate === name || (candidate.startsWith(`${stem}-`) && !candidate.startsWith(`${stem}-vlow-`) && candidate.endsWith('.glb')))
}

const assets = [
  'palace-material-review.glb',
  'palace-material-review-vlow.glb'
]
let status = 'failed'
try {
  check('loader-module', existsSync(path.join(repoRoot, 'src/renderer/src/components/office/kit/palace/palaceResource.ts')), 'Palace resource loader source exists')
  const resource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/office/kit/palace/palaceResource.ts'), 'utf8')
  check('loader-uses-local-glb-urls', resource.includes('palace-material-review.glb?url') && resource.includes('palace-material-review-vlow.glb?url'), 'high and low tiers use bundled local GLB imports')
  check('loader-uses-gltf-loader', resource.includes("import('three/examples/jsm/loaders/GLTFLoader.js')") && resource.includes('loadAsync'), 'loader uses GLTFLoader.loadAsync')
  const architecturePath = path.join(repoRoot, 'src/renderer/src/components/office/kit/palace/PalaceArchitecture.tsx')
  const architecture = readFileSync(architecturePath, 'utf8')
  check('loader-fail-closed-error-boundary', architecture.includes("data-office-palace-loaded', 'error'") && architecture.includes('onReady?.(false)'), '3D load errors produce an explicit renderer error state')
  check('loader-success-boundary', architecture.includes("data-office-palace-loaded', '1'") && architecture.includes('onReady?.(true)'), '3D readiness is emitted only after loaded geometry renders')

  const sourceRecords = new Map()
  for (const name of assets) {
    const parsed = parseGlb(path.join(sourceRoot, name))
    sourceRecords.set(name, parsed)
    await parseWithGltfLoader(path.join(sourceRoot, name))
  }
  check('source-assets-are-distinct-tiers', sourceRecords.get(assets[0]).digest !== sourceRecords.get(assets[1]).digest, 'high and low tier assets have distinct content digests')

  check('built-renderer-assets-directory', existsSync(outRoot) && statSync(outRoot).isDirectory(), 'electron-vite renderer output exists')
  const builtNames = readdirSync(outRoot)
  for (const name of assets) {
    const source = sourceRecords.get(name)
    const candidates = builtAssetCandidates(builtNames, name)
    check(`built-asset:${name}`, candidates.length === 1, `expected one hashed output ending in ${name}; found ${candidates.join(', ') || '(none)'}`)
    const builtPath = path.join(outRoot, candidates[0])
    const built = readFileSync(builtPath)
    check(`built-asset:${name}:digest`, sha256(built) === source.digest, 'built asset bytes match the source asset digest')
    parseGlb(builtPath)
    await parseWithGltfLoader(builtPath)
  }
  const outputBundle = readdirSync(outRoot).find((candidate) => /^palaceResource-.*\.js$/u.test(candidate))
  check('built-palace-resource-bundle', Boolean(outputBundle), 'renderer output contains the Palace resource bundle')
  if (outputBundle) {
    const bundle = readFileSync(path.join(outRoot, outputBundle), 'utf8')
    const outputAssetNames = assets.map((name) => {
      return builtAssetCandidates(builtNames, name)[0]
    })
    check('bundle-references-hashed-glb-assets', outputAssetNames.every((name) => name && bundle.includes(name)), 'Palace resource bundle retains both hashed local asset filenames')
    check('bundle-keeps-gltf-loader', bundle.includes('GLTFLoader') && bundle.includes('loadAsync'), 'compiled Palace resource bundle retains loader path')
  }
  const rendererJs = builtNames
    .filter((candidate) => candidate.endsWith('.js'))
    .map((candidate) => readFileSync(path.join(outRoot, candidate), 'utf8'))
    .join('\n')
  check('bundle-surfaces-stale-runtime', rendererJs.includes('data-palace-scene-freshness') && rendererJs.includes('staleReason'), 'compiled renderer retains explicit stale projection marker')
  status = 'passed'
  writeReport(status)
  console.log(`palace scene packaged runtime: PASS (${checks.filter((item) => item.status === 'passed').length}/${checks.length})`)
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  writeReport(status, detail)
  console.error(`palace scene packaged runtime: FAIL — ${detail}`)
  process.exitCode = 1
}
