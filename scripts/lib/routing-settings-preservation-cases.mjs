import assert from 'node:assert/strict'

/** Ordinary settings edits must not silently relax a saved routing boundary. */
export function verifyRoutingSettingsPreservation(settings, checks) {
  const original = settings.getSettings()
  try {
    for (const locality of ['local_only', 'prefer_local']) {
      settings.updateSettings({ routingExpertPolicy: { allowedProviderIds: ['preserved-provider'], locality } })
      settings.updateSettings({ language: original.language })
      assert.deepEqual(settings.getSettings().routingExpertPolicy, {
        allowedProviderIds: ['preserved-provider'], locality,
        allowedRegions: [], allowedDomains: [], requiredPermissions: []
      }, 'ordinary settings update changed routing policy')
      settings.updateSettings({ routingExpertPolicy: { allowedProviderIds: ['updated-provider'] } })
      assert.equal(settings.getSettings().routingExpertPolicy.locality, locality, 'partial provider allowlist update relaxed locality')
      settings.updateSettings({ routingExpertPolicy: { allowedProviderIds: ['updated-provider'], locality: 'any' } })
      assert.equal(settings.getSettings().routingExpertPolicy.locality, 'any', 'explicit locality change must remain possible')
    }
    checks.push('ordinary and partial settings updates preserve routing locality; explicit changes still apply')
  } finally {
    settings.updateSettings({ routingExpertPolicy: original.routingExpertPolicy })
  }
}
