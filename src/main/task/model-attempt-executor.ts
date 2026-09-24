import { version as buildVersion } from '../../../package.json'
import {
  modelAttemptError,
  safeText,
  sha256Digest,
  type ModelAttemptStartInput,
  type ModelExecutorReceipt,
  type NativeModelExecutorComponent
} from '../../shared/model-attempt-types'
import {
  ANTHROPIC_NATIVE_RUNTIME_ADAPTER,
  GOOGLE_NATIVE_RUNTIME_ADAPTER,
  OPENAI_NATIVE_RUNTIME_ADAPTER
} from '../native-runtime-contract'
import { canonicalJson, digest } from './workflow-ledger-codec'

type AttemptTarget = Pick<ModelAttemptStartInput, 'providerId' | 'model' | 'protocol' | 'adapterVersion'>
const COMPONENTS = {
  openai_engine: { id: 'caogen.native.openai', engine: OPENAI_NATIVE_RUNTIME_ADAPTER.engineKind, protocols: ['openai.chat-completions', 'openai.responses'] },
  anthropic_engine: { id: 'caogen.native.anthropic', engine: ANTHROPIC_NATIVE_RUNTIME_ADAPTER.engineKind, protocols: ['anthropic.messages'] },
  google_genai_runtime: { id: 'caogen.native.gemini', engine: GOOGLE_NATIVE_RUNTIME_ADAPTER.engineKind, protocols: ['google.generative-language'] },
  // The decomposer is a separate request executor, not a full native conversational engine.
  model_dag_decomposer: { id: 'caogen.native.model-dag-decomposer', engine: 'openai', protocols: ['openai.chat-completions', 'openai.responses'] }
} as const

/** Called by the concrete runtime, before opening the durable Attempt and before Provider I/O. */
export function createNativeModelExecutorReceipt(component: NativeModelExecutorComponent, target: AttemptTarget): ModelExecutorReceipt {
  const implementation = COMPONENTS[component]
  if (!implementation) throw invalid('native executor component is not implemented')
  const identity = {
    schemaVersion: 1 as const,
    source: 'native_runtime' as const,
    executorId: implementation.id,
    executorVersion: buildVersion,
    component,
    engineKind: implementation.engine,
    executionDomain: 'native_text' as const
  }
  return Object.freeze(normalizeModelExecutorReceipt({ ...identity, bindingDigest: bindingDigest(identity, target) }, target)!)
}

/** Validation keeps old absence intact and accepts recorded build versions after application upgrades. */
export function normalizeModelExecutorReceipt(value: unknown, target: AttemptTarget): ModelExecutorReceipt | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('executor receipt must be an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'bindingDigest,component,engineKind,executionDomain,executorId,executorVersion,schemaVersion,source') {
    throw invalid('executor receipt contains unsupported or missing fields')
  }
  if (record.schemaVersion !== 1 || record.source !== 'native_runtime' || record.executionDomain !== 'native_text') {
    throw invalid('executor receipt provenance is invalid')
  }
  if (typeof record.component !== 'string' || !Object.hasOwn(COMPONENTS, record.component)) throw invalid('executor component is unknown')
  const component = record.component as NativeModelExecutorComponent
  const implementation = COMPONENTS[component]
  if (record.executorId !== implementation.id || record.engineKind !== implementation.engine ||
      !(implementation.protocols as readonly string[]).includes(target.protocol)) {
    throw invalid('executor identity and model protocol are incompatible')
  }
  const executorVersion = safeText(record.executorVersion, 'executor version', 80)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(executorVersion)) throw invalid('executor version must identify an EastGenesis build')
  const identity = {
    schemaVersion: 1 as const, source: 'native_runtime' as const,
    executorId: implementation.id, executorVersion, component,
    engineKind: implementation.engine, executionDomain: 'native_text' as const
  }
  const expected = bindingDigest(identity, target)
  const normalized = { ...identity, bindingDigest: sha256Digest(record.bindingDigest, 'executor binding digest') }
  if (normalized.bindingDigest !== expected || canonicalJson(normalized) !== canonicalJson(value)) {
    throw invalid('executor receipt does not match this persisted model combination')
  }
  return normalized
}

function bindingDigest(identity: Omit<ModelExecutorReceipt, 'bindingDigest'>, target: AttemptTarget): string {
  return `sha256:${digest({
    format: 'caogen.model-executor-binding.v1', executor: identity,
    providerId: safeText(target.providerId, 'provider id', 160),
    model: safeText(target.model, 'model', 240),
    protocol: safeText(target.protocol, 'protocol', 120),
    adapterVersion: safeText(target.adapterVersion, 'adapter version', 120)
  })}`
}

function invalid(message: string) {
  return modelAttemptError('MODEL_ATTEMPT_INVALID_INPUT', message)
}
