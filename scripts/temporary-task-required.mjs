import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'caogen-temporary-required-')))
const parent = join(root, 'main'), outside = join(root, 'outside')
mkdirSync(parent); mkdirSync(outside)
writeFileSync(join(parent, 'sessions.json'), 'main-history')
writeFileSync(join(parent, 'memory.txt'), 'main-memory')
writeFileSync(join(outside, 'result.txt'), 'explicitly exported result')
let checks = 0, child
const pass = name => { checks++; console.log(`PASS ${name}`) }
const cwd = process.cwd(), saved = { CAOGEN_USER_DATA_DIR: process.env.CAOGEN_USER_DATA_DIR,
  CAOGEN_TEMPORARY_PROFILE_ID: process.env.CAOGEN_TEMPORARY_PROFILE_ID, CAOGEN_MEMORY_DIR: process.env.CAOGEN_MEMORY_DIR }
async function bundle(contents, stubs = {}) {
  const result = await build({ stdin: { contents, resolveDir: cwd, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    } }] })
  const filename = resolve('scripts/.temporary-task-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(result.outputFiles[0].text, filename)
  return module.exports
}
try {
  const api = await bundle(`export * from './src/main/temporary-task/profile-store'; export * from './src/main/temporary-task/profile-seed'; export * from './src/main/user-rules';`)
  const profile = api.createTemporaryProfile(parent)
  for (const name of ['chromium', 'logs', 'memory', 'personal-workspace']) assert(existsSync(join(profile.root, name)))
  assert(!existsSync(join(profile.root, 'sessions.json')))
  assert.throws(() => api.removeTemporaryProfile(parent, profile.id), /仍在运行或启动/)
  assert.throws(() => api.profilePath(parent, '../../outside'), /标识无效/)
  pass('a newly registered profile has separate storage roots and cannot delete a starting or foreign path')

  const provider = { id: 'fixture', name: 'Fixture', baseUrl: 'https://example.invalid/v1', engine: 'openai', openaiProtocol: 'chat', authMode: 'api-key', models: ['fixture-model'], createdAt: 1,
    encryptedToken: '', activeKeyId: 'encrypted', apiKeys: [
      { id: 'encrypted', label: 'Saved', createdAt: 1, encryptedToken: 'enc:fixture-only' },
      { id: 'session', label: 'Session', createdAt: 1, encryptedToken: '', sessionOnly: true },
      { id: 'legacy', label: 'Legacy', createdAt: 1, encryptedToken: 'b64:fixture-only' }
    ], note: '/main/private/data', advancedConfig: { request: { body: { source: '/main/private' } },
      modelProfiles: [{ model: 'fixture-model', capabilities: ['vision'], contextWindow: 128000, verification: { generation: 'passed' },
        pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, source: 'user' }, request: { source: '/main/private' } }] } }
  const providers = api.temporaryProviders([provider, { ...provider, id: 'oauth', authorization: { provider: 'fixture-oauth' } }])
  assert.equal(providers.length, 1); assert.deepEqual(providers[0].apiKeys.map(key => key.id), ['encrypted'])
  assert.equal(providers[0].note, undefined); assert.equal(providers[0].advancedConfig.request, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(providers[0].advancedConfig)), { schemaVersion: 1, modelProfiles: [{ model: 'fixture-model', capabilities: ['vision'], contextWindow: 128000, pricing: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, source: 'user' } }] })
  assert.equal(api.temporaryProviders([{ ...provider, advancedConfig: { request: { body: {} } } }])[0].advancedConfig, undefined)
  assert.equal(providers[0].apiKeys[0].encryptedToken, provider.apiKeys[0].encryptedToken)
  const settings = api.temporarySettings({ theme: 'light', language: 'zh', persona: 'private user rules', autoSkillLearningEnabled: true, guiAutomationEnabled: true,
    desktopCompanion: { enabled: true }, defaultProviderId: 'fixture', defaultModel: 'fixture-model', externalPath: '/main/project' })
  assert.equal(settings.autoSkillLearningEnabled, false); assert.equal(settings.persona, '')
  assert.equal(settings.externalPath, undefined); assert.equal(settings.desktopCompanion, undefined)
  pass('connection seeding copies only sealed API keys and selected fields; OAuth, session secrets, private references and global instructions stay out')

  process.env.CAOGEN_USER_DATA_DIR = profile.root; process.env.CAOGEN_TEMPORARY_PROFILE_ID = profile.id
  process.env.CAOGEN_MEMORY_DIR = join(parent, 'old-memory')
  const paths = new Map([['appData', parent]])
  globalThis.__temporaryApp = { setName: () => {}, setPath: (key, value) => paths.set(key, value), getPath: key => paths.get(key) }
  await bundle(`export * from './src/main/app-runtime-paths';`, { electron: 'module.exports = { app: globalThis.__temporaryApp }' })
  assert.equal(paths.get('userData'), profile.root)
  assert.equal(paths.get('sessionData'), join(profile.root, 'chromium'))
  assert.equal(paths.get('logs'), join(profile.root, 'logs'))
  assert.equal(process.env.CAOGEN_MEMORY_DIR, join(profile.root, 'memory'))
  assert.equal(process.cwd(), join(profile.root, 'personal-workspace'))
  assert.equal(api.readTemporaryProfile(profile.root).childPid, process.pid)
  assert.equal(api.buildUserRulesSystemAppendSync(parent), '')
  process.chdir(cwd)
  pass('the real early bootstrap redirects Electron userData, browser storage, logs, working directory and memory before other modules initialize')

  globalThis.__temporarySkillMaterializations = []
  const extensions = await bundle(`export * from './src/main/plugin/caogen-extension-roots'; export * from './src/main/skill/skill-loader'; export * from './src/main/pluginRegistry';`, {
    '../learning/learning-lifecycle': 'module.exports = { ensureProjectSkillReadinessSync: root => globalThis.__temporarySkillMaterializations.push(root) }',
    './plugin/plugin-trust': 'module.exports = { projectPluginRegistryItemTrust: item => ({ item }) }'
  })
  const skillRoot = join(profile.root, '.caogen', 'skills'), outsideExtensionRoot = join(outside, '.caogen')
  mkdirSync(join(skillRoot, 'temporary-fixture'), { recursive: true })
  mkdirSync(join(outsideExtensionRoot, 'skills', 'outside-fixture'), { recursive: true })
  writeFileSync(join(skillRoot, 'temporary-fixture', 'SKILL.md'), '---\nname: Temporary fixture\n---\n# Temporary fixture\nTemporary profile skill.')
  writeFileSync(join(outsideExtensionRoot, 'skills', 'outside-fixture', 'SKILL.md'), '---\nname: Outside fixture\n---\n# Outside fixture\nMust not be discovered.')
  assert.deepEqual(extensions.defaultSkillRoots(outside), [{ root: skillRoot, scope: 'global' }])
  assert.equal(extensions.caogenUserExtensionRoot(parent), join(profile.root, '.caogen'))
  assert.equal(extensions.caogenManagedPluginsRoot(parent), join(profile.root, '.caogen', 'plugins'))
  assert.deepEqual(extensions.caogenExtensionRegistryRoots([outside], parent), [join(profile.root, '.caogen')])
  const loadedSkills = extensions.loadSkills(outside)
  assert(loadedSkills.skills.some(skill => skill.name === 'Temporary fixture'))
  assert(!loadedSkills.skills.some(skill => skill.name === 'Outside fixture'))
  assert.deepEqual(globalThis.__temporarySkillMaterializations, [])
  const registry = extensions.scanPluginRegistry([outsideExtensionRoot, '~/.caogen'])
  assert.deepEqual(registry.roots, [join(profile.root, '.caogen')])
  assert(registry.items.some(item => item.name === 'Temporary fixture'))
  assert(!registry.items.some(item => item.name === 'Outside fixture'))
  const linkedProject = join(profile.root, 'personal-workspace', 'linked-project')
  symlinkSync(outside, linkedProject)
  assert(!extensions.isAllowedCaogenExtensionRoot(join(linkedProject, '.caogen', 'skills')))
  assert.deepEqual(extensions.defaultSkillRoots(linkedProject), [{ root: skillRoot, scope: 'global' }])
  unlinkSync(linkedProject)
  pass('temporary skill loading and plugin discovery use the recording directory, skip external roots and symlinks, and never materialize external project skills')

  child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  api.saveTemporaryProfile({ ...profile, state: 'running', childPid: child.pid })
  assert.equal(api.listTemporaryProfiles(parent)[0].state, 'running')
  assert.throws(() => api.removeTemporaryProfile(parent, profile.id), /仍在运行或启动/)
  const ended = once(child, 'exit'); child.kill(); await ended; child = undefined
  assert.equal(api.listTemporaryProfiles(parent)[0].state, 'cleanup_pending')
  writeFileSync(join(profile.root, 'personal-workspace', 'transient.txt'), 'temporary work')
  api.removeTemporaryProfile(parent, profile.id)
  assert(!existsSync(profile.root))
  assert.equal(readFileSync(join(parent, 'sessions.json'), 'utf8'), 'main-history')
  assert.equal(readFileSync(join(parent, 'memory.txt'), 'utf8'), 'main-memory')
  assert.equal(readFileSync(join(outside, 'result.txt'), 'utf8'), 'explicitly exported result')
  pass('cleanup waits for a real child process to exit and deletes only its registered profile; main history, memory and exported files survive')

  const linked = api.createTemporaryProfile(parent)
  rmSync(linked.root, { recursive: true }); symlinkSync(outside, linked.root)
  assert.throws(() => api.removeTemporaryProfile(parent, linked.id, () => false), /独立目录/)
  unlinkSync(linked.root)
  assert.equal(readFileSync(join(outside, 'result.txt'), 'utf8'), 'explicitly exported result')
  pass('replacing a registered profile with an outside symlink fails closed before deletion')
  const parentAlias = join(root, 'parent-alias')
  symlinkSync(parent, parentAlias)
  const aliased = api.createTemporaryProfile(parentAlias)
  assert.equal(aliased.root, api.profilePath(parent, aliased.id))
  api.saveTemporaryProfile({ ...aliased, state: 'exited' })
  api.removeTemporaryProfile(parentAlias, aliased.id, () => false)
  assert(!existsSync(aliased.root)); unlinkSync(parentAlias)
  pass('a normal parent-path alias resolves to the canonical registry while profile and registry symlinks remain forbidden')
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const childScript = join(root, 'offline-child.cjs')
  writeFileSync(childScript, `process.on('message', value => { if (value.kind === 'temporary-task:finish' && value.profileId === process.env.CAOGEN_TEMPORARY_PROFILE_ID) setTimeout(() => process.exit(0), 120) }); setInterval(() => {}, 1000)`)
  globalThis.__temporaryLaunch = { root: parent, childScript, providers: [provider], settings: { defaultProviderId: 'fixture', defaultModel: 'fixture-model', autoSkillLearningEnabled: true } }
  const service = await bundle(`export * from './src/main/temporary-task/temporary-task-service';`, {
    electron: 'module.exports = { app: { getPath: () => globalThis.__temporaryLaunch.root, getAppPath: () => globalThis.__temporaryLaunch.childScript, isPackaged: false }, ipcMain: {}, shell: {} }',
    '../ipc/workflow-ledger-handlers': 'module.exports = { assertTrustedWorkflowLedgerSender: () => {} }',
    '../settings': 'module.exports = { getSettings: () => globalThis.__temporaryLaunch.settings }',
    '../providers': 'module.exports = { loadProviderProfileStore: () => globalThis.__temporaryLaunch.providers, persistedProviders: value => value }'
  })
  const [launched, duplicate] = await Promise.all([service.openTemporaryTask(), service.openTemporaryTask()])
  assert.equal(launched.id, duplicate.id)
  const launchedRoot = api.profilePath(parent, launched.id)
  assert.equal(JSON.parse(readFileSync(join(launchedRoot, 'providers.json'), 'utf8')).entries[0].id, 'fixture')
  assert(!existsSync(join(launchedRoot, 'sessions.json')))
  assert.equal(service.temporaryTaskState().profiles.length, 1)
  assert.equal(service.temporaryTaskState().profiles[0].canEnd, true)
  await assert.rejects(service.endTemporaryTask('foreign-child'), /不由当前主窗口管理/)
  const ending = service.endTemporaryTask(launched.id)
  assert.equal(service.endTemporaryTask(launched.id), ending)
  assert(existsSync(launchedRoot), 'asking a child to quit is not evidence that it exited')
  await ending
  assert(!existsSync(launchedRoot))
  pass('ending a specific child rejects unknown ownership, deduplicates requests, and returns only after observed exit and cleanup')
  const finalChild = await service.openTemporaryTask()
  const finalRoot = api.profilePath(parent, finalChild.id)
  await service.finishTemporaryTaskChildren()
  assert(!existsSync(finalRoot))
  assert.equal(readFileSync(join(parent, 'sessions.json'), 'utf8'), 'main-history')
  pass('the actual launch service deduplicates concurrent requests and waits for its offline child to exit before profile cleanup')
  console.log(`temporary-task-required: ${checks}/${checks}; temporary files and offline Node children only; no real Provider, credentials or app profile used`)
} finally {
  child?.kill(); process.chdir(cwd)
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  delete globalThis.__temporaryApp
  delete globalThis.__temporaryLaunch
  delete globalThis.__temporarySkillMaterializations
  rmSync(root, { recursive: true, force: true })
}
