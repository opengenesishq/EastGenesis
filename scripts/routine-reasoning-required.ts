import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoutine, listRoutines, updateRoutine } from '../src/main/routineStore'
import { applyProviderRequestOverrides } from '../src/main/provider/providerRequestOverrides'
import { applyGoogleRuntimeToRequest } from '../src/main/googleGenAiRequest'
import { normalizeTaskReasoning, taskReasoningOptions, withTaskReasoning } from '../src/shared/task-reasoning'

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'caogen-routine-controls-'))
  try {
    const routine = await createRoutine(root, { name: 'Fixture', prompt: 'Summarize local changes', projectCwd: root, schedule: 'every 30m', executionLocation: 'worktree', reasoningEffort: 'high' })
    assert.equal((await listRoutines(root))[0].reasoningEffort, 'high'); assert.equal((await listRoutines(root))[0].executionLocation, 'worktree')
    await updateRoutine(root, routine.id, { name: 'Keep controls' })
    assert.equal((await listRoutines(root))[0].reasoningEffort, 'high')
    await updateRoutine(root, routine.id, { executionLocation: 'local', reasoningEffort: undefined })
    assert.equal((await listRoutines(root))[0].reasoningEffort, undefined)
    await assert.rejects(updateRoutine(root, routine.id, { executionLocation: 'elsewhere' as never }), /执行位置/)
    assert.throws(() => normalizeTaskReasoning('made-up'), /推理强度/)
    const provider = { baseUrl: 'https://fixture.invalid', advancedConfig: { runtime: { reasoningEffort: 'low' as const, temperature: 0.3 } } }
    const selected = withTaskReasoning(provider, 'high', 'openai')
    const responses = applyProviderRequestOverrides(selected, provider.baseUrl, { model: 'fixture', input: [] }).body
    assert.deepEqual((responses as any).reasoning, { effort: 'high' }); assert.equal(provider.advancedConfig.runtime.reasoningEffort, 'low')
    const chat = applyProviderRequestOverrides(selected, provider.baseUrl, { model: 'fixture', messages: [] }).body
    assert.equal((chat as any).reasoning_effort, 'high')
    const gemini = withTaskReasoning(provider, 'medium', 'gemini')
    const wire = applyGoogleRuntimeToRequest({ model: 'fixture', messages: [], maxTokens: 4096 }, gemini.advancedConfig?.runtime)
    assert.equal((wire.extraBody as any).generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM')
    assert.throws(() => withTaskReasoning(provider, 'xhigh', 'gemini'), /协议/)
    assert.throws(() => withTaskReasoning(provider, 'high', 'anthropic'), /协议/)
    assert.deepEqual(taskReasoningOptions(undefined, 'unknown'), [])
    console.log('PASS 5 routine controls groups: persistence/reset, invalid values, Responses/Chat overrides without provider mutation, Gemini mapping, unsupported protocol')
  } finally { await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
