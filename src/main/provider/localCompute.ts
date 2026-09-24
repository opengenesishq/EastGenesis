import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import type {
  LocalComputeActivationOptions,
  LocalComputeActivationResult,
  LocalComputeService,
  ProviderModelProfile,
  ProviderView
} from '../../shared/types'
import { createProvider, listProviders, updateProvider } from '../providers'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

interface LocalComputeCandidate {
  service: LocalComputeService
  name: string
  baseUrl: string
  modelsPath: string
  /** Optional runtime-owned model detail endpoint. Missing capability evidence stays unknown. */
  modelDetailsPath?: string
}

const MAX_RESPONSE_BYTES = 1024 * 1024
const PROBE_TIMEOUT_MS = 900
const STARTUP_TIMEOUT_MS = 8_000
const STARTUP_POLL_MS = 200
const LOCAL_COMPUTE_PROVIDER_NOTE = 'EastGenesis 自动发现的本机模型服务'
let activation: Promise<LocalComputeActivationResult> | null = null
let activationCanStart = false

export function activateLocalCompute(
  options: LocalComputeActivationOptions | null = {}
): Promise<LocalComputeActivationResult> {
  const startInstalled = options?.startInstalled === true
  if (activation) {
    if (!startInstalled || activationCanStart) return activation
    return activation.then((result) => result.status === 'activated'
      ? result
      : beginActivation(true))
  }
  return beginActivation(startInstalled)
}

function beginActivation(startInstalled: boolean): Promise<LocalComputeActivationResult> {
  const pending = activate(startInstalled)
  activation = pending
  activationCanStart = startInstalled
  const clear = (): void => {
    if (activation !== pending) return
    activation = null
    activationCanStart = false
  }
  void pending.then(clear, clear)
  return pending
}

async function activate(startInstalled: boolean): Promise<LocalComputeActivationResult> {
  const checkedAt = Date.now()
  const candidates = localComputeCandidates()
  const results = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    probe: await probeModels(candidate)
  })))
  const match = results.find((result) => result.probe.models.length > 0)
  if (match) return activatedResult(checkedAt, match.candidate, match.probe.models, match.probe.modelProfiles)

  const reachable = results.find((result) => result.probe.reachable)
  if (reachable) {
    return {
      status: 'unavailable',
      checkedAt,
      service: reachable.candidate.service,
      reason: 'model-missing'
    }
  }

  const command = ollamaStartCommand()
  if (!command) return { status: 'unavailable', checkedAt, reason: 'runtime-missing' }
  if (!startInstalled) {
    return { status: 'unavailable', checkedAt, service: 'ollama', reason: 'runtime-stopped' }
  }

  const ollama = candidates.find((candidate) => candidate.service === 'ollama')
  if (!ollama || !(await startRuntime(command))) {
    return { status: 'unavailable', checkedAt, service: 'ollama', reason: 'runtime-stopped' }
  }
  const probe = await waitForModels(ollama)
  if (probe.models.length > 0) {
    return {
      ...activatedResult(checkedAt, ollama, probe.models, probe.modelProfiles),
      startedService: true
    }
  }
  return {
    status: 'unavailable',
    checkedAt,
    service: 'ollama',
    reason: probe.reachable ? 'model-missing' : 'runtime-stopped',
    startedService: true
  }
}

function activatedResult(
  checkedAt: number,
  candidate: LocalComputeCandidate,
  models: string[],
  modelProfiles?: ProviderModelProfile[]
): LocalComputeActivationResult {
  const provider = ensureProvider(candidate, models, modelProfiles)
  return {
    status: 'activated',
    checkedAt,
    service: candidate.service,
    provider
  }
}

function ensureProvider(candidate: LocalComputeCandidate, models: string[], modelProfiles?: ProviderModelProfile[]): ProviderView {
  const existing = listProviders().find((provider) =>
    canonicalTarget(provider.baseUrl) === canonicalTarget(candidate.baseUrl)
    && provider.engine === 'openai'
  )
  const managed = !existing || existing.note === LOCAL_COMPUTE_PROVIDER_NOTE
  const input = {
    name: candidate.name,
    baseUrl: candidate.baseUrl,
    models,
    engine: 'openai' as const,
    openaiProtocol: 'chat' as const,
    authMode: 'none' as const,
    note: LOCAL_COMPUTE_PROVIDER_NOTE,
    // Replace the auto-discovered profile set on every probe. If the runtime
    // stops advertising tools, stale evidence must disappear on the next
    // activation; a missing declaration remains fail-closed. A provider with
    // a user-owned note keeps its manually configured advanced profile.
    ...(managed
      ? {
          advancedConfig: {
            ...(existing?.advancedConfig ?? { schemaVersion: 1 as const }),
            modelProfiles: modelProfiles ?? []
          }
        }
      : {})
  }
  return existing ? updateProvider(existing.id, input) : createProvider(input)
}

interface LocalComputeProbe {
  reachable: boolean
  models: string[]
  modelProfiles?: ProviderModelProfile[]
}

async function probeModels(candidate: LocalComputeCandidate): Promise<LocalComputeProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${candidate.baseUrl}${candidate.modelsPath}`, {
      method: 'GET',
      signal: controller.signal
    })
    if (!response.ok) return { reachable: false, models: [] }
    const length = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return { reachable: true, models: [] }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { reachable: true, models: [] }
    const models = modelNames(JSON.parse(text), candidate.service)
    const modelProfiles = candidate.modelDetailsPath
      ? await probeModelProfiles(candidate, models)
      : []
    return { reachable: true, models, ...(modelProfiles.length > 0 ? { modelProfiles } : {}) }
  } catch {
    return { reachable: false, models: [] }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ollama exposes model capabilities through /api/show. Only values explicitly
 * returned by that endpoint become a saved profile; a missing/failed detail
 * probe deliberately leaves the model unknown so routing remains fail-closed.
 */
async function probeModelProfiles(
  candidate: LocalComputeCandidate,
  models: string[]
): Promise<ProviderModelProfile[]> {
  if (!candidate.modelDetailsPath || models.length === 0) return []
  const profiles = await Promise.all(models.map(async (model): Promise<ProviderModelProfile | undefined> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const response = await fetch(`${candidate.baseUrl}${candidate.modelDetailsPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
        signal: controller.signal
      })
      if (!response.ok) return undefined
      const length = Number(response.headers.get('content-length') || 0)
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return undefined
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return undefined
      const root = recordValue(JSON.parse(text))
      const capabilities = Array.isArray(root?.capabilities)
        ? root.capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()).slice(0, 32)
        : []
      const contextWindow = modelContextWindow(root?.model_info)
      if (capabilities.length === 0 && contextWindow === undefined) return undefined
      return {
        model,
        ...(capabilities.length > 0 ? { capabilities } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow })
      }
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }))
  return profiles.filter((profile): profile is ProviderModelProfile => Boolean(profile))
}

function modelContextWindow(value: unknown): number | undefined {
  const record = recordValue(value)
  if (!record) return undefined
  const candidate = Object.entries(record).find(([key, raw]) =>
    /context(?:_|-)?length/i.test(key) && typeof raw === 'number' && Number.isInteger(raw) && raw > 0
  )?.[1]
  return typeof candidate === 'number' ? candidate : undefined
}

async function waitForModels(candidate: LocalComputeCandidate): Promise<LocalComputeProbe> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let last: LocalComputeProbe = { reachable: false, models: [] }
  while (Date.now() < deadline) {
    last = await probeModels(candidate)
    if (last.reachable) return last
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS))
  }
  return last
}

interface LocalRuntimeCommand {
  executable: string
  args: string[]
}

function ollamaStartCommand(): LocalRuntimeCommand | null {
  const testMode = !app.isPackaged && process.env.CAOGEN_LOCAL_COMPUTE_TEST_MODE === '1'
  if (testMode) {
    const executable = existingFile(process.env.CAOGEN_LOCAL_COMPUTE_TEST_RUNTIME_EXECUTABLE)
    const script = existingFile(process.env.CAOGEN_LOCAL_COMPUTE_TEST_RUNTIME_SCRIPT)
    const controlUrl = loopbackBaseUrl(process.env.CAOGEN_LOCAL_COMPUTE_TEST_CONTROL_URL)
    return executable && script && controlUrl
      ? { executable, args: [script, 'serve', controlUrl] }
      : null
  }
  const executable = findOllamaExecutable()
  return executable ? { executable, args: ['serve'] } : null
}

function findOllamaExecutable(): string | null {
  const names = process.platform === 'win32' ? ['ollama.exe'] : ['ollama']
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const candidates = pathEntries.flatMap((entry) => names.map((name) => join(entry, name)))
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Ollama.app/Contents/Resources/ollama')
    candidates.push(join(homedir(), '.ollama', 'bin', 'ollama'))
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', join(homedir(), '.local', 'bin', 'ollama'))
  }
  for (const candidate of candidates) {
    const file = existingFile(candidate)
    if (file) return file
  }
  return null
}

function existingFile(value: string | undefined): string | null {
  if (!value || !isAbsolute(value) || !existsSync(value)) return null
  try {
    return statSync(value).isFile() ? value : null
  } catch {
    return null
  }
}

function startRuntime(command: LocalRuntimeCommand): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (started: boolean): void => {
      if (settled) return
      settled = true
      resolve(started)
    }
    try {
      const child = spawn(command.executable, command.args, {
        detached: true,
        env: buildMinimalSubprocessEnv(),
        stdio: 'ignore',
        windowsHide: true
      })
      child.once('spawn', () => {
        child.unref()
        finish(true)
      })
      child.once('error', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

function modelNames(value: unknown, service: LocalComputeService): string[] {
  const root = recordValue(value)
  const rows = service === 'ollama'
    ? root?.models
    : root?.data
  if (!Array.isArray(rows)) return []
  const output: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const record = recordValue(row)
    const raw = service === 'ollama'
      ? record?.name ?? record?.model
      : record?.id
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!name || name.length > 240 || seen.has(name)) continue
    seen.add(name)
    output.push(name)
    if (output.length >= 500) break
  }
  return output
}

function localComputeCandidates(): LocalComputeCandidate[] {
  const testUrl = process.env.CAOGEN_LOCAL_COMPUTE_TEST_MODE === '1'
    ? loopbackBaseUrl(process.env.CAOGEN_LOCAL_COMPUTE_TEST_BASE_URL)
    : null
  if (testUrl) {
    return [{
      service: 'ollama',
      name: 'Ollama（本机）',
      baseUrl: testUrl,
      modelsPath: '/api/tags',
      modelDetailsPath: '/api/show'
    }]
  }
  return [
    {
      service: 'ollama',
      name: 'Ollama（本机）',
      baseUrl: 'http://127.0.0.1:11434',
      modelsPath: '/api/tags',
      modelDetailsPath: '/api/show'
    },
    {
      service: 'lm-studio',
      name: 'LM Studio（本机）',
      baseUrl: 'http://127.0.0.1:1234',
      modelsPath: '/v1/models'
    },
    {
      service: 'vllm',
      name: 'vLLM（本机）',
      baseUrl: 'http://127.0.0.1:8000',
      modelsPath: '/v1/models'
    }
  ]
}

function loopbackBaseUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) return null
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function canonicalTarget(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
