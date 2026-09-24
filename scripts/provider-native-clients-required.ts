import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import { parseNativeClientConfiguration, readNativeClientSnapshot } from '../src/main/provider/providerNativeClientConfig'

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'caogen-native-clients-'))
  const write = (relative: string, content: string | Buffer): void => {
    const path = join(home, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
  }
  try {
    const claude = parseNativeClientConfiguration('claude', { model: 'sonnet', env: {
      ANTHROPIC_BASE_URL: 'https://fixture.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'synthetic-claude-key', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet'
    }, apiKeyHelper: 'touch MUST_NOT_EXECUTE' }, {})[0]
    assert.equal(claude.input.engine, 'anthropic'); assert.deepEqual(claude.input.models, ['fixture-sonnet'])
    assert.deepEqual(claude.input.credentialHeaderNames, ['authorization']); assert.equal(claude.token, 'synthetic-claude-key')
    assert.equal(JSON.stringify(claude.input).includes('synthetic-claude-key'), false)
    assert.equal(JSON.stringify(claude).includes('MUST_NOT_EXECUTE'), false)

    write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_API_KEY: 'synthetic-first' } }))
    const claudeSnapshot = await readNativeClientSnapshot('claude', home, {})
    assert.equal(claudeSnapshot.sourceDigest, claudeSnapshot.readDigest())
    write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_API_KEY: 'synthetic-changed' } }))
    assert.notEqual(claudeSnapshot.sourceDigest, claudeSnapshot.readDigest())

    write('.gemini/settings.json', JSON.stringify({ model: { name: 'fixture-gemini' } }))
    write('.gemini/.env', 'GEMINI_API_KEY="synthetic-gemini" # comment\nGOOGLE_GEMINI_BASE_URL=https://fixture.example/gemini\nUNRELATED_COMMAND=$(do-not-run)')
    const gemini = (await readNativeClientSnapshot('gemini', home, {})).candidates[0]
    assert.equal(gemini.input.engine, 'gemini'); assert.equal(gemini.token, 'synthetic-gemini')
    assert.deepEqual(gemini.input.models, ['fixture-gemini']); assert.equal(JSON.stringify(gemini).includes('do-not-run'), false)

    write('.config/opencode/opencode.jsonc', `{
      // preserve URL slashes inside strings and permit trailing commas
      "model": "fixture/fixture-chat", "provider": { "fixture": {
        "npm": "@ai-sdk/openai-compatible", "options": {"baseURL":"https://fixture.example/v1", "apiKey":"{env:FIXTURE_API_KEY}",},
        "models": {"fixture-chat":{},}, // trailing comment
      },},
    }`)
    const fixtureEnv = { FIXTURE_API_KEY: 'synthetic-openai' }
    const open = await readNativeClientSnapshot('opencode', home, fixtureEnv)
    assert.equal(open.candidates[0].input.openaiProtocol, 'chat'); assert.equal(open.candidates[0].token, 'synthetic-openai')
    assert.equal(open.candidates[0].credentialKind, 'environment')
    fixtureEnv.FIXTURE_API_KEY = 'synthetic-changed'; assert.notEqual(open.sourceDigest, open.readDigest())
    const unsupported = parseNativeClientConfiguration('opencode', { provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: '{file:private-key}' } } } }, {})
    assert.equal(unsupported[0].token, undefined)
    const oauth = parseNativeClientConfiguration('opencode', { auth: { openai: { type: 'oauth', access: 'never-import' } } }, {})
    assert.equal(oauth.length, 0)
    const builtin = parseNativeClientConfiguration('opencode', { model: 'openai/fixture-response', auth: { openai: { type: 'api', key: 'synthetic-stored' } } }, {})
    assert.equal(builtin[0].token, 'synthetic-stored'); assert.deepEqual(builtin[0].input.models, ['fixture-response'])

    const nodeRequire = createRequire(import.meta.url)
    const SQL = await initSqlJs({ locateFile: () => nodeRequire.resolve('sql.js/dist/sql-wasm.wasm') })
    const db = new SQL.Database()
    db.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER, sort_index INTEGER)')
    const records = [
      ['claude', { env: { ANTHROPIC_API_KEY: 'synthetic-cc-claude', ANTHROPIC_MODEL: 'fixture-c' } }],
      ['gemini', { env: { GEMINI_API_KEY: 'synthetic-cc-gemini', GEMINI_MODEL: 'fixture-g' } }],
      ['codex', { auth: { OPENAI_API_KEY: 'synthetic-cc-codex' }, config: 'model="fixture-r"\nmodel_provider="relay"\n[model_providers.relay]\nbase_url="https://fixture.example/v1"\nwire_api="responses"' }],
      ['opencode', { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://fixture.example/v1', apiKey: 'synthetic-cc-open' }, models: { 'fixture-o': {} } }]
    ] as const
    for (const [client, config] of records) db.run('INSERT INTO providers VALUES (?, ?, ?, ?, 1, 0)', [client, client, `Fixture ${client}`, JSON.stringify(config)])
    write('.cc-switch/cc-switch.db', Buffer.from(db.export())); db.close()
    const cc = await readNativeClientSnapshot('cc-switch', home, {})
    assert.equal(cc.candidates.length, 4); assert.equal(cc.sourceDigest, cc.readDigest())
    assert.deepEqual(cc.candidates.map((candidate) => candidate.input.engine).sort(), ['anthropic', 'gemini', 'openai', 'openai'])
    assert.equal(cc.candidates.find((candidate) => candidate.input.name === 'Fixture codex')?.input.openaiProtocol, 'responses')
    write('.cc-switch/cc-switch.db-wal', 'synthetic-pending-wal')
    assert.notEqual(cc.sourceDigest, cc.readDigest())
    await assert.rejects(readNativeClientSnapshot('cc-switch', home, {}), /CC Switch/)
    console.log('PASS: Native client parsing, credential isolation, environment/source drift, JSONC, CC Switch SQLite snapshot and pending-write protection (synthetic fixtures only).')
  } finally { rmSync(home, { recursive: true, force: true }) }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
