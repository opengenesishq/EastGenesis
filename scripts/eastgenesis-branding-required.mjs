#!/usr/bin/env node
/**
 * Product-facing brand boundary for EastGenesis.
 *
 * Historical `caogen` identifiers remain in storage, protocol and migration
 * paths. This gate checks that the app metadata, release artifacts and
 * current product documents expose EastGenesis to users.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const checks = []

function pass(name) {
  checks.push(name)
  console.log(`[PASS] ${name}`)
}

function check(condition, message) {
  assert.ok(condition, message)
}

check(packageJson.productName === 'EastGenesis', 'package productName must be EastGenesis')
check(packageJson.name === 'caogen', 'legacy package name must remain stable for migration compatibility')
check(packageJson.build?.appId === 'com.caogen.app', 'legacy appId must remain stable for migration compatibility')
check(packageJson.build?.publish?.[0]?.owner === 'opengenesishq', 'formal publish target must use the EastGenesis release owner')
check(packageJson.build?.publish?.[0]?.repo === 'EastGenesis', 'formal publish target must use the EastGenesis repository name')
check(!String(packageJson.author?.url ?? '').toLowerCase().includes('caogen'), 'package metadata still exposes the legacy CaoGen website')
pass('package metadata separates EastGenesis product name from legacy compatibility identifiers')

const rendererHtml = read('src/renderer/index.html')
check(rendererHtml.includes('<title>EastGenesis</title>'), 'renderer document title is stale')
const runtimePaths = read('src/main/app-runtime-paths.ts')
check(runtimePaths.includes("app.setName('EastGenesis')"), 'Electron app name is stale')
const main = read('src/main/index.ts')
check(main.includes("title: temporaryTaskRuntime ? '临时工作空间 · EastGenesis' : 'EastGenesis'"), 'main window title is stale')
pass('renderer and Electron window branding use EastGenesis')

const brand = read('src/renderer/src/brand.ts')
const store = read('src/renderer/src/store.ts')
const rendererCopy = read('src/renderer/src/i18n.ts')
const providerSetupCopy = read('src/renderer/src/i18n/providerSetupTranslations.ts')
check(brand.includes('export const ENABLE_PALACE_EXPERIENCE = false'), 'paused 3D experience must stay disabled')
check(store.includes("if (view === 'office' && !ENABLE_PALACE_EXPERIENCE)"), 'legacy 3D deep links must return to the workbench')
check(!/3D 故宫|3D Palace|3D 画质/.test(rendererCopy), 'paused 3D copy still appears in active renderer translations')
check(providerSetupCopy.includes('供 EastGenesis 工作台任务共用'), 'provider setup still exposes removed business-line entry copy')
check(!/assistant, project, video, and custom business lines|助手、项目、视频和自定义业务线/.test(providerSetupCopy), 'provider setup still names removed project/video business lines')
pass('paused 3D experience is absent from the active product path')

const previewBuilder = read('electron-builder.windows-preview.cjs')
check(previewBuilder.includes("artifactName: 'EastGenesis-${version}-windows-x64-unsigned-preview.${ext}'"), 'Windows preview artifact name is stale')
const releaseMatrix = read('scripts/lib/release-platform-matrix.mjs')
check(releaseMatrix.includes('EastGenesis-${version}'), 'release matrix does not use EastGenesis artifacts')
check(!releaseMatrix.includes('CaoGen-') && !releaseMatrix.includes('CaoGen Setup'), 'release matrix still exposes CaoGen artifact names')
const releasePolicy = read('scripts/lib/release-packaging-policy.mjs')
check(releasePolicy.includes('EastGenesis-${version}-windows-x64-unsigned-preview.${ext}'), 'release policy still expects a CaoGen preview artifact')
pass('release artifact naming uses EastGenesis')

for (const file of ['README.md', 'STATUS.md', 'CHANGELOG.md', 'ARCHITECTURE-V2.md', 'ACCEPTANCE-MATRIX-V2.md', 'COMMERCIAL-LICENSE.md', 'SECURITY.md']) {
  const text = read(file)
  check(!/^# CaoGen(?:\s|$)/mu.test(text), `${file} still uses a CaoGen product heading`)
  check(!/CaoGen\.app|CaoGen-\$\{version\}|CaoGen 主流程|CaoGen 是|CaoGen V\d/mu.test(text), `${file} still contains stale user-facing CaoGen wording`)
}
pass('current product documents use EastGenesis wording')

const visibleSurfaces = [
  ['NOTICE', /EastGenesis/, /CaoGen|caogen\.dev/],
  ['docs/CHAT-SHARE-ADAPTER.md', /EastGenesis/, /CaoGen/],
  ['docs/HOSTED-SITE-ENVIRONMENT.md', /EastGenesis/, /CaoGen/],
  ['GOLDEN-USER-TASKS/README.md', /EastGenesis/, /CaoGen/],
  ['src/shared/provider-presets.ts', /EastGenesis 中转站/, /CaoGen 中转站/],
  ['src/shared/desktop-git-preferences.ts', /EastGenesis worktree/, /CaoGen worktree/],
  ['src/main/projectContextEffect.ts', /保存 EastGenesis 项目规则/, /保存 caogen\.md 项目规则/],
  ['src/renderer/src/i18n.ts', /EastGenesis 的本机扩展目录/, /\.caogen 目录/],
  ['src/renderer/src/components/settings/ProviderUsageDashboard.tsx', /eastgenesis-usage-/, /caogen-usage-/],
  ['src/renderer/src/components/settings/DesktopThemeSettings.tsx', /eastgenesis-theme\.json/, /caogen-theme\.json/],
  ['src/renderer/src/components/settings/GitPreferences.tsx', /eastgenesis\/任务标识/, /caogen\/任务标识/],
  ['src/main/ipc/studio-result-handlers.ts', /eastgenesis-delivery-/, /caogen-delivery-/],
  ['src/main/ipc/provider-profile-handlers.ts', /eastgenesis-provider-profile-/, /caogen-provider-profile-/],
  ['src/main/project-workspace/project-connector-read-adapter.ts', /EastGenesis-Project-Connector/, /CaoGen-Project-Connector/]
]
for (const [file, expected, stale] of visibleSurfaces) {
  const text = read(file)
  check(expected.test(text), `${file} is missing EastGenesis-facing copy`)
  check(!stale.test(text), `${file} still exposes stale CaoGen-facing copy`)
}
pass('packaged notices, adapters and default copy use EastGenesis')

// GitHub forms, CI artifact labels and signing globs are public release surfaces too.
// Their internal environment variable names remain compatibility identifiers, but
// anything a contributor or downloader sees must use the current product name.
const publicReleaseSurfaces = [
  ['.github/ISSUE_TEMPLATE/config.yml', /github\.com\/opengenesishq\/EastGenesis/, /github\.com\/opengenesishq\/CaoGen/],
  ['COMMERCIAL-LICENSE.md', /EastGenesis GitHub Issues/, /github\.com\/opengenesishq\/CaoGen/],
  ['.github/ISSUE_TEMPLATE/bug_report.yml', /EastGenesis/, /CaoGen/],
  ['.github/ISSUE_TEMPLATE/feature_request.yml', /EastGenesis/, /CaoGen/],
  ['.github/DISCUSSION_TEMPLATE/general.yml', /EastGenesis/, /CaoGen/],
  ['.github/DISCUSSION_TEMPLATE/ideas.yml', /EastGenesis/, /CaoGen/],
  ['.github/DISCUSSION_TEMPLATE/q-a.yml', /EastGenesis/, /CaoGen/],
  ['.github/workflows/windows-unsigned-build.yml', /EastGenesis/, /CaoGen(?: Setup|-)/],
  ['.github/workflows/macos-x64-office-diagnostics.yml', /EastGenesis/, /name:\s+CaoGen/],
  ['.github/workflows/community-response-sla.yml', /EastGenesis/, /name:\s+CaoGen/],
  ['.github/workflows/baseline.yml', /EastGenesis/, /name:\s+CaoGen/],
  ['.signpath/artifact-configuration.xml', /EastGenesis-/, /CaoGen-/]
]
for (const [file, expected, stale] of publicReleaseSurfaces) {
  const text = read(file)
  check(expected.test(text), `${file} is missing EastGenesis public release branding`)
  check(!stale.test(text), `${file} still exposes stale CaoGen public release branding`)
}
pass('public issue forms, CI artifacts and signing configuration use EastGenesis')

console.log(`EastGenesis branding contract: passed (${checks.length} checks)`)
