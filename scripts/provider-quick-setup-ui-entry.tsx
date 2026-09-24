import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProviderEditor from '../src/renderer/src/components/ProviderEditor'
import { useStore } from '../src/renderer/src/store'
import type { ProviderInput, ProviderView, ProviderModelFetchInput } from '../src/shared/types'
import '../src/renderer/src/styles.css'

const host = window as typeof window & { IS_REACT_ACT_ENVIRONMENT: boolean; runQuickSetupChecks(): Promise<string[]>; showQuickSetup(stage: string): Promise<void> }
host.IS_REACT_ACT_ENVIRONMENT = true
const root = createRoot(document.getElementById('root')!)
const original = useStore.getState()
const savedInputs: ProviderInput[] = [], discoveries: ProviderModelFetchInput[] = []
let failDiscovery = false, revision = 0
const assert = (ok: unknown, message: string): void => { if (!ok) throw Error(message) }
const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector); assert(node, `Missing ${selector}`); return node!
}
const click = async (selector: string): Promise<void> => { await act(async () => find(selector).click()) }
const type = async (selector: string, value: string): Promise<void> => {
  await act(async () => {
    const node = find<HTMLInputElement | HTMLTextAreaElement>(selector)
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const select = async (selector: string, value: string): Promise<void> => {
  await act(async () => {
    const node = find<HTMLSelectElement>(selector)
    node.value = value
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const mount = async (): Promise<void> => {
  failDiscovery = false
  await act(async () => {
    useStore.setState({ settings: { ...original.settings, language: 'zh', defaultProviderId: 'existing', defaultModel: 'auto' },
      providers: [], createProvider: async input => {
        savedInputs.push(input)
        const provider = { ...input, id: `provider-${savedInputs.length}`, hasToken: !!input.token, keyCount: input.token ? 1 : 0, apiKeys: [], ready: true, credentialStorage: 'encrypted', createdAt: Date.now() } as ProviderView
        useStore.setState({ providers: [...useStore.getState().providers, provider] })
        return provider
      }, updateSettings: async () => { throw Error('Existing default routing must not be overwritten') }
    })
    window.agentDesk = { ...window.agentDesk,
      listMediaProviders: async () => [],
      fetchProviderModels: async input => {
        discoveries.push(input)
        return failDiscovery ? { ok: false, models: [], baseUrl: input.baseUrl, cacheKey: 'fixture' } :
          { ok: true, models: ['fixture-general', 'fixture-code'], baseUrl: input.baseUrl, cacheKey: 'fixture' }
      }
    }
    root.render(<ProviderEditor key={++revision} provider={null} onClose={() => {}} />)
  })
}

host.runQuickSetupChecks = async () => {
  const checks: string[] = []
  await mount()
  assert(find<HTMLButtonElement>('[data-provider-quick-action="save"]').disabled, 'Must explicitly choose provider')
  await click('[data-provider-preset="openai"]')
  assert(!find<HTMLDetailsElement>('[data-provider-quick-connection-details]').open, 'Advanced settings should begin collapsed')
  assert(find<HTMLInputElement>('[data-provider-quick-field="api-key"]').value === '', 'No inherited key')
  await type('[data-provider-quick-field="api-key"]', 'fixture-openai-key')
  await click('[data-provider-quick-action="save"]')
  const first = savedInputs.at(-1)!
  assert(first.baseUrl === 'https://api.openai.com/v1' && first.openaiProtocol === 'responses' && first.models.length === 2, 'Official endpoint/protocol/discovered models mismatch')
  assert(first.credentialHeaderNames?.join() === 'authorization', 'Credential header lost')
  assert(document.querySelector('[data-provider-setup-receipt]'), 'Save receipt missing')
  assert(!find<HTMLDetailsElement>('.provider-simple-receipt-details').open, 'Saved connection should not require advanced configuration')
  checks.push('Official provider needs only a key; response protocol, headers, models and simple receipt preserved')

  await mount(); await click('[data-provider-preset="openai"]')
  await type('[data-provider-quick-field="api-key"]', 'fixture-private-to-openai')
  await click('[data-provider-selected] button'); await click('[data-provider-preset="glm"]')
  assert(find<HTMLInputElement>('[data-provider-quick-field="api-key"]').value === '', 'Changing vendor retained prior vendor key')
  await type('[data-provider-quick-field="api-key"]', 'fixture-glm-key')
  await click('[data-provider-quick-action="save"]')
  assert(savedInputs.at(-1)?.engine === 'anthropic' && savedInputs.at(-1)?.credentialHeaderNames?.join() === 'authorization', 'Preset credential overrides lost')
  checks.push('Changing vendor clears credentials and applies the selected vendor authentication')

  await mount(); await click('[data-provider-preset="lmstudio"]')
  assert(!document.querySelector('[data-provider-quick-field="api-key"]'), 'Local preset asks for key')
  await click('[data-provider-quick-action="save"]')
  assert(savedInputs.at(-1)?.authMode === 'none' && !savedInputs.at(-1)?.token && savedInputs.at(-1)?.baseUrl === 'http://localhost:1234/v1', 'Local preset not saved as local')
  checks.push('Local models are discovered without a key or stale credential')

  await mount(); await click('[data-provider-preset="azure-openai"]')
  await click('[data-provider-quick-action="save"]')
  assert(document.querySelector('[role="alert"]'), 'Missing Azure endpoint accepted')
  await type('[data-provider-quick-field="base-url"]', 'https://fixture.openai.azure.com/openai/v1')
  await type('[data-provider-quick-field="api-key"]', 'fixture-azure-key')
  await type('[data-provider-quick-field="models"]', 'my-deployment')
  const count = discoveries.length
  await click('[data-provider-quick-action="save"]')
  assert(discoveries.length === count && savedInputs.at(-1)?.models.join() === 'my-deployment' && savedInputs.at(-1)?.credentialHeaderNames?.join() === 'api-key', 'Deployment configuration not carried to save')
  checks.push('Resource-specific service asks only for required endpoint, key and deployment')

  await mount(); await click('[data-provider-preset="openai"]')
  await type('[data-provider-quick-field="api-key"]', 'fixture-fallback-key'); failDiscovery = true
  const before = savedInputs.length
  await click('[data-provider-quick-action="save"]')
  assert(savedInputs.length === before && find<HTMLDetailsElement>('[data-provider-quick-connection-details]').open, 'Failed discovery saved silently or hid fallback')
  await type('[data-provider-quick-field="models"]', 'fixture-manual')
  await click('[data-provider-quick-action="manual-save"]')
  assert(savedInputs.at(-1)?.models.join() === 'fixture-manual', 'Explicit manual fallback cannot be saved')
  assert(find('[data-provider-setup-stage="models"]').dataset.state === 'manual', 'Manual model labelled as discovered')
  checks.push('Discovery failure remains visible and explicit manual fallback is recorded as manual')

  await mount(); await click('[data-provider-preset="glm"]')
  await type('[data-provider-quick-field="api-key"]', 'fixture-draft-key')
  await click('[data-provider-quick-action="advanced"]')
  assert(find<HTMLInputElement>('[data-provider-field="api-key"]').value === 'fixture-draft-key' && find<HTMLSelectElement>('[data-provider-field="engine"]').value === 'anthropic', 'Advanced editor lost draft')
  checks.push('Opening advanced configuration retains the selected connection and entered key')

  for (const [protocol, engine, header] of [['chat', 'openai', 'authorization'], ['responses', 'openai', 'authorization'], ['anthropic', 'anthropic', 'x-api-key'], ['gemini', 'gemini', 'x-goog-api-key']] as const) {
    await mount(); await click('[data-provider-preset="custom"]')
    await type('[data-provider-quick-field="base-url"]', 'https://fixture.example/api')
    await type('[data-provider-quick-field="api-key"]', 'fixture-custom-key')
    await select('[data-provider-quick-field="protocol"]', protocol)
    await click('[data-provider-quick-action="save"]')
    const saved = savedInputs.at(-1)!, discovery = discoveries.at(-1)!
    assert(saved.engine === engine && saved.openaiProtocol === (protocol === 'responses' ? 'responses' : 'chat') && saved.credentialHeaderNames?.join() === header, `Quick custom ${protocol} saved incorrectly`)
    assert(discovery.engine === saved.engine && discovery.openaiProtocol === saved.openaiProtocol && discovery.credentialHeaderNames?.join() === header, 'Discovery and saved connection diverged')
  }
  checks.push('Custom service supports all four protocols with matching discovery, saved connection and automatic authentication headers')

  await mount(); await click('[data-provider-preset="perplexity"]')
  assert(!find<HTMLDetailsElement>('.provider-simple-manual-models').open, 'Built-in models still require a manual model form')
  await type('[data-provider-quick-field="api-key"]', 'fixture-sonar-key')
  const beforePreset = discoveries.length
  await click('[data-provider-quick-action="save"]')
  assert(discoveries.length === beforePreset && savedInputs.at(-1)?.models.join() === 'sonar', 'Built-in model was not used directly')
  checks.push('Services with a built-in model save with only a key; additional model input stays optional')
  return checks
}
host.showQuickSetup = async stage => {
  await mount()
  if (stage !== 'catalog') await click('[data-provider-preset="openai"]')
}
