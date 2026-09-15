export function verifySessionChoiceContract(sessionManager, lifecycle, assert) {
  assert(
    sessionManager.includes('prepareSessionCreationDraft(opts, parentMeta)') &&
      lifecycle.includes('const provider = localPlanOnly ? undefined : explicitSessionProvider(selectedProviderId, selectedModel)') &&
      lifecycle.includes('engine: provider ? resolveProviderEngine(provider) : \'openai\'') &&
      lifecycle.includes("!historySource && !parentMeta && input.taskStrategy === 'plan'") &&
      lifecycle.includes('!listProviders().some(providerIsReady)') &&
      !lifecycle.includes('engine: opts.engine') &&
      lifecycle.includes("if (!model) throw new Error('请选择模型或显式选择自动调度')") &&
      lifecycle.includes("if (!providerId) throw new Error('请选择可用 Provider')") &&
      lifecycle.includes('if (!providerIsReady(provider))'),
    'Execution Session creation must resolve a ready Provider/model; only a new canonical unrouted local plan may defer Provider selection'
  )
}
