#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodeRgbaPng } from './lib/png-rgba.mjs'

const repoRoot = process.cwd()
const startedAt = new Date().toISOString()
const runId = startedAt.replace(/[:.]/gu, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'watercolor-accessibility')
const assetRoot = path.join(repoRoot, 'src/renderer/src/assets/watercolor-characters')
const roles = ['researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations']
const states = ['idle', 'thinking', 'tool-running', 'awaiting-approval', 'blocked', 'repairing', 'delivering']
const backgrounds = { light: [245, 243, 238], dark: [31, 36, 39] }
const thresholds = {
  contrastCoverage3to1: 0.12,
  grayscaleSpread: 0.08,
  visiblePixels48: 8,
  visiblePixels96: 30,
  grayscaleStdDev48: 0.02,
  grayscaleStdDev96: 0.02,
  stateSignatureDistance: 0.01,
  roleSignatureDistance: 0.01
}
let report

try {
  const files = expectedFiles()
  assert.deepEqual(
    readdirSync(assetRoot).filter((file) => file.endsWith('.png')).sort(),
    [...files].sort(),
    'runtime asset directory must contain exactly the 7x7 PNG contract'
  )
  const assets = files.map(analyzeAsset)
  const violations = assets.flatMap((asset) => validateAsset(asset))
  const distinctness = analyzeDistinctness(assets)
  violations.push(...validateDistinctness(distinctness))
  const sourceChecks = verifyProductionAccessibilityCues()
  assert.deepEqual(violations, [])
  report = buildReport('passed', assets, distinctness, sourceChecks, [])
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const errorRecord = serializeError(error)
  report = report ?? buildReport('failed', [], null, [], [errorRecord])
  console.error(error)
  process.exitCode = 1
} finally {
  writeReport(report)
}

function analyzeAsset(filename) {
  const filePath = path.join(assetRoot, filename)
  const bytes = readFileSync(filePath)
  const image = decodeRgbaPng(bytes)
  const contrast = Object.fromEntries(
    Object.entries(backgrounds).map(([name, background]) => [name, contrastMetrics(image, background)])
  )
  return {
    filename,
    role: roles.find((role) => filename.startsWith(`role-${role}-`)),
    state: states.find((state) => filename.includes(`-state-${state}-`)),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contrast,
    grayscaleSpread: grayscaleSpread(image),
    scale48: smallScaleMetrics(image, 48),
    scale96: smallScaleMetrics(image, 96),
    signature: grayscaleSignature(image, 12, 18)
  }
}

function contrastMetrics(image, background) {
  const backgroundLuminance = relativeLuminance(background)
  let visible = 0
  let passing = 0
  let contrastSum = 0
  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) {
      const offset = (y * image.width + x) * 4
      const alpha = image.pixels[offset + 3] / 255
      if (alpha <= 0.0625) continue
      const composite = [0, 1, 2].map((channel) =>
        Math.round(image.pixels[offset + channel] * alpha + background[channel] * (1 - alpha))
      )
      const ratio = contrastRatio(relativeLuminance(composite), backgroundLuminance)
      visible += 1
      contrastSum += ratio
      if (ratio >= 3) passing += 1
    }
  }
  return {
    sampledVisiblePixels: visible,
    coverage3to1: round(passing / visible),
    meanContrast: round(contrastSum / visible)
  }
}

function grayscaleSpread(image) {
  const values = []
  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) {
      const offset = (y * image.width + x) * 4
      if (image.pixels[offset + 3] < 64) continue
      values.push(relativeLuminance([
        image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]
      ]))
    }
  }
  values.sort((left, right) => left - right)
  return round(percentile(values, 0.9) - percentile(values, 0.1))
}

function smallScaleMetrics(image, targetHeight) {
  const targetWidth = Math.round(targetHeight * image.width / image.height)
  const luminances = []
  let visiblePixels = 0
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / targetWidth))
      const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / targetHeight))
      const offset = (sourceY * image.width + sourceX) * 4
      const alpha = image.pixels[offset + 3] / 255
      if (alpha <= 0.0625) continue
      visiblePixels += 1
      const source = [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]]
      const composite = source.map((channel) => Math.round(channel * alpha + 242 * (1 - alpha)))
      luminances.push(relativeLuminance(composite))
    }
  }
  return {
    width: targetWidth,
    height: targetHeight,
    visiblePixels,
    grayscaleStdDev: round(standardDeviation(luminances))
  }
}

function grayscaleSignature(image, width, height) {
  const signature = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width))
      const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height))
      const offset = (sourceY * image.width + sourceX) * 4
      const alpha = image.pixels[offset + 3] / 255
      const luminance = relativeLuminance([
        image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]
      ])
      signature.push(round(alpha * (1 - luminance)))
    }
  }
  return signature
}

function validateAsset(asset) {
  const violations = []
  for (const background of Object.keys(backgrounds)) {
    const coverage = asset.contrast[background].coverage3to1
    if (coverage < thresholds.contrastCoverage3to1) {
      violations.push(`${asset.filename}: ${background} 3:1 coverage ${coverage} below threshold`)
    }
  }
  if (asset.grayscaleSpread < thresholds.grayscaleSpread) {
    violations.push(`${asset.filename}: grayscale spread ${asset.grayscaleSpread} below threshold`)
  }
  for (const [name, threshold] of [['scale48', thresholds.visiblePixels48], ['scale96', thresholds.visiblePixels96]]) {
    if (asset[name].visiblePixels < threshold) {
      violations.push(`${asset.filename}: ${name} visible pixels ${asset[name].visiblePixels} below ${threshold}`)
    }
  }
  if (asset.scale48.grayscaleStdDev < thresholds.grayscaleStdDev48) {
    violations.push(`${asset.filename}: 48px grayscale standard deviation is too low`)
  }
  if (asset.scale96.grayscaleStdDev < thresholds.grayscaleStdDev96) {
    violations.push(`${asset.filename}: 96px grayscale standard deviation is too low`)
  }
  return violations
}

function analyzeDistinctness(assets) {
  const statePairs = roles.flatMap((role) => pairwise(assets.filter((asset) => asset.role === role)))
  const rolePairs = pairwise(assets.filter((asset) => asset.state === 'idle'))
  return {
    statePairs: statePairs.length,
    rolePairs: rolePairs.length,
    minimumStateSignatureDistance: round(Math.min(...statePairs.map((pair) => pair.distance))),
    minimumRoleSignatureDistance: round(Math.min(...rolePairs.map((pair) => pair.distance))),
    closestStatePair: closestPair(statePairs),
    closestRolePair: closestPair(rolePairs)
  }
}

function pairwise(assets) {
  const pairs = []
  for (let left = 0; left < assets.length; left += 1) {
    for (let right = left + 1; right < assets.length; right += 1) {
      pairs.push({
        left: assets[left].filename,
        right: assets[right].filename,
        distance: signatureDistance(assets[left].signature, assets[right].signature)
      })
    }
  }
  return pairs
}

function validateDistinctness(metrics) {
  const violations = []
  if (metrics.minimumStateSignatureDistance < thresholds.stateSignatureDistance) {
    violations.push(`minimum grayscale state distance ${metrics.minimumStateSignatureDistance} below threshold`)
  }
  if (metrics.minimumRoleSignatureDistance < thresholds.roleSignatureDistance) {
    violations.push(`minimum grayscale role distance ${metrics.minimumRoleSignatureDistance} below threshold`)
  }
  return violations
}

function verifyProductionAccessibilityCues() {
  const rig = source('src/renderer/src/components/office/kit/WatercolorCharacterRig.tsx')
  const office = source('src/renderer/src/components/office/OfficeView.tsx')
  assert.match(rig, /prefers-reduced-motion:\s*reduce/u)
  assert.match(rig, /watercolorState:\s*state/u)
  assert.match(rig, /<spriteMaterial/u)
  assert.doesNotMatch(rig, /<Text\b|Robot|\.glb/iu)
  assert.match(office, /aria-label=\{t\(`officePreset/u)
  assert.match(office, /aria-pressed=\{cameraPreset === preset\}/u)
  assert.match(office, /aria-label=\{t\('officeOpenSession'\)\}/u)
  assert.match(office, /data-office-waiting-approval-sessions/u)
  assert.match(office, /data-office-failed-sessions/u)
  return [
    'reduced-motion-resets-animation',
    'state-is-available-as-non-color-scene-metadata',
    'camera-controls-have-label-title-and-pressed-state',
    'open-session-command-has-accessible-name',
    'approval-and-failure-have-textual-count-projections',
    'character-rig-does-not-overlay-text-or-render-robot-assets'
  ]
}

function expectedFiles() {
  return roles.flatMap((role) => states.map((state) => `role-${role}-state-${state}-v01.png`))
}

function relativeLuminance(rgb) {
  const linear = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(left, right) {
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
}

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}

function standardDeviation(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
}

function signatureDistance(left, right) {
  const meanSquare = left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0) / left.length
  return Math.sqrt(meanSquare)
}

function closestPair(pairs) {
  return [...pairs].sort((left, right) => left.distance - right.distance)[0] ?? null
}

function round(value) {
  return Number(value.toFixed(6))
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function buildReport(status, assets, distinctness, sourceChecks, errors) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const gitStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
  return {
    schemaVersion: 1,
    status,
    gate: 'test:watercolor-accessibility:required',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    git: { commit, worktreeClean: gitStatus.length === 0 },
    contract: { roles, states, assets: roles.length * states.length, thresholds },
    sourceChecks,
    distinctness,
    assets: assets.map(({ signature, ...asset }) => asset),
    errors,
    humanReview: {
      status: 'open',
      boundary: 'Automated pixel and source checks do not substitute for blinded target-user recognition.'
    }
  }
}

function writeReport(value) {
  mkdirSync(path.join(reportRoot, runId), { recursive: true })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path.join(reportRoot, runId, 'report.json'), serialized, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  }
}
