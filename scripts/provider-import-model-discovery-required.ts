import assert from 'node:assert/strict'
import type { ProviderManagementApi, ProviderModelFetchInput, ProviderView } from '../src/shared/types'
import { discoverImportedProviderModels, ImportedModelsError } from '../src/renderer/src/components/settings/native-provider-model-discovery'

type Api = Pick<ProviderManagementApi, 'listProviders' | 'fetchProviderModels' | 'updateProvider'>
function fixture(): { api: Api; state: { provider: ProviderView | undefined; requests: ProviderModelFetchInput[]; updates: number; duringFetch?: () => void; fail?: boolean; stale?: boolean } } {
  const state = {
    provider: { id: 'fixture-provider', name: 'Imported fixture', baseUrl: 'https://fixture.example/v1', models: [],
      engine: 'openai', openaiProtocol: 'responses', authMode: 'api-key', customHeaders: '{"x-fixture":"native"}',
      credentialHeaderNames: ['authorization'], hasToken: true, activeKeyId: 'fixture-key' } as ProviderView | undefined,
    requests: [] as ProviderModelFetchInput[], updates: 0, duringFetch: undefined as (() => void) | undefined,
    fail: false, stale: false
  }
  const api: Api = {
    async listProviders() { return state.provider ? [structuredClone(state.provider)] : [] },
    async fetchProviderModels(input) {
      state.requests.push(input); state.duringFetch?.()
      return { ok: !state.fail, models: ['fixture-one', 'fixture-two', 'fixture-one'], baseUrl: input.baseUrl, cacheKey: 'fixture-cache', stale: state.stale }
    },
    async updateProvider(id, patch) { assert.equal(id, state.provider?.id); state.updates++; state.provider = { ...state.provider!, models: patch.models! }; return state.provider }
  }
  return { api, state }
}
async function main(): Promise<void> {
  const success = fixture()
  const saved = await discoverImportedProviderModels('fixture-provider', success.api)
  assert.deepEqual(saved.models, ['fixture-one', 'fixture-two'])
  assert.equal(success.state.updates, 1)
  assert.deepEqual(success.state.requests[0], { providerId: 'fixture-provider', baseUrl: 'https://fixture.example/v1', engine: 'openai',
    openaiProtocol: 'responses', authMode: 'api-key', customHeaders: '{"x-fixture":"native"}', credentialHeaderNames: ['authorization'] })
  assert.equal('token' in success.state.requests[0], false)

  const concurrent = fixture()
  concurrent.state.duringFetch = () => { concurrent.state.provider!.models = ['manually-added'] }
  assert.deepEqual((await discoverImportedProviderModels('fixture-provider', concurrent.api)).models, ['manually-added', 'fixture-one', 'fixture-two'])

  for (const mutation of ['baseUrl', 'activeKeyId', 'delete'] as const) {
    const changed = fixture()
    changed.state.duringFetch = () => {
      if (mutation === 'delete') changed.state.provider = undefined
      else changed.state.provider![mutation] = 'changed'
    }
    await assert.rejects(discoverImportedProviderModels('fixture-provider', changed.api), (error) => error instanceof ImportedModelsError && ['missing', 'changed'].includes(error.reason))
    assert.equal(changed.state.updates, 0)
  }
  for (const reason of ['fail', 'stale'] as const) {
    const unavailable = fixture(); unavailable.state[reason] = true
    await assert.rejects(discoverImportedProviderModels('fixture-provider', unavailable.api), (error) => error instanceof ImportedModelsError && error.reason === 'unavailable')
    assert.equal(unavailable.state.updates, 0)
  }
  console.log('PASS: Saved-credential model discovery, preserved connection binding, concurrent model merge, removed/changed provider rejection, failed/stale response preservation (synthetic fixtures only).')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
