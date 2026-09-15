import type { SchedulerStrategy } from '../shared/types'
import { reliabilityScore } from './modelStats'
import { isProviderAvailable } from './providerHealth'
import type { FailureClass } from './providerHealth'

export {
  acquireProviderRequest,
  classifyFailure,
  configureProviderCircuitBreaker,
  configureProviderHealthDir,
  getHealth,
  isProviderAvailable,
  listHealth,
  recordFailure,
  recordProbeFailure,
  recordProbeSuccess,
  releaseProviderRequest,
  recordSuccess
} from './providerHealth'
export type { FailureClass, ProviderFailureRecord, ProviderHealth } from './providerHealth'

/** 模型能力档:quality/cost/speed 各 1-3(3 最高)。tier 用于按复杂度匹配。 */
interface ModelCap {
  quality: 1 | 2 | 3
  cost: 1 | 2 | 3
  speed: 1 | 2 | 3
}

/**
 * 已知模型能力表。键为归一化后的模型名子串匹配。
 * 未知模型给中庸默认,避免调度器对新模型无所适从。
 */
const CAP_TABLE: Array<{ match: RegExp; cap: ModelCap }> = [
  { match: /opus/i, cap: { quality: 3, cost: 3, speed: 1 } },
  { match: /sonnet/i, cap: { quality: 2, cost: 2, speed: 2 } },
  { match: /haiku/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /gpt-4o-mini|4o-mini/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /gpt-4o|gpt-4\.1|o3|o1/i, cap: { quality: 3, cost: 2, speed: 2 } },
  { match: /gpt-3\.5|mini|flash|lite/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /gemini.*pro|1\.5-pro|2\.0-pro/i, cap: { quality: 3, cost: 2, speed: 2 } },
  { match: /deepseek.*(reasoner|r1)/i, cap: { quality: 3, cost: 1, speed: 1 } },
  { match: /deepseek/i, cap: { quality: 2, cost: 1, speed: 2 } },
  // 国产模型档位(厂商 Anthropic 兼容端点直连,一等公民)
  { match: /kimi-k2|kimi.*thinking/i, cap: { quality: 3, cost: 1, speed: 2 } },
  { match: /kimi|moonshot/i, cap: { quality: 2, cost: 1, speed: 2 } },
  { match: /glm-4\.5-air|glm.*flash/i, cap: { quality: 1, cost: 1, speed: 3 } },
  { match: /glm/i, cap: { quality: 2, cost: 1, speed: 2 } },
  { match: /qwen.*max|qwen3/i, cap: { quality: 3, cost: 2, speed: 2 } },
  { match: /qwen/i, cap: { quality: 2, cost: 1, speed: 2 } }
]

const DEFAULT_CAP: ModelCap = { quality: 2, cost: 2, speed: 2 }

function capOf(model: string): ModelCap {
  for (const { match, cap } of CAP_TABLE) if (match.test(model)) return cap
  return DEFAULT_CAP
}

export type Complexity = 'simple' | 'medium' | 'complex'

const COMPLEX_HINTS =
  /重构|refactor|架构|architect|设计|design|实现整个|migrat|审查|review|调试|debug|优化性能|optimi|整个项目|whole (repo|project)|端到端|end.to.end/i
const SIMPLE_HINTS =
  /^(查看|列出|显示|读一下|读取|什么是|解释一下|list|show|read|cat|explain|翻译|translate|格式化|format)\b/i

/** 按消息文本启发式判定复杂度 */
export function classifyComplexity(text: string): Complexity {
  const t = text.trim()
  if (t.length > 400 || COMPLEX_HINTS.test(t)) return 'complex'
  if (t.length < 80 && SIMPLE_HINTS.test(t)) return 'simple'
  if (t.length < 40) return 'simple'
  return 'medium'
}

/** 复杂度目标质量档:complex→3, medium→2, simple→1 */
function targetQuality(c: Complexity): 1 | 2 | 3 {
  return c === 'complex' ? 3 : c === 'medium' ? 2 : 1
}

export interface RouteDecision {
  model: string
  reason: string
  complexity: Complexity
}

/**
 * 从候选模型里挑一个。
 * - quality:满足复杂度前提下选质量最高
 * - cost:满足复杂度前提下选成本最低
 * - speed:从可用模型中优先选择速度档最高者
 * - balanced:选质量档最接近目标档的(打平再比成本)
 */
export function pickModel(
  candidates: string[],
  text: string,
  strategy: SchedulerStrategy
): RouteDecision | null {
  const pool = candidates.filter(Boolean)
  if (pool.length === 0) return null
  const complexity = classifyComplexity(text)
  const target = targetQuality(complexity)

  const scored = pool.map((model) => ({ model, cap: capOf(model) }))

  let chosen: { model: string; cap: ModelCap }
  if (strategy === 'quality') {
    chosen = scored.reduce((a, b) => (b.cap.quality > a.cap.quality ? b : a))
  } else if (strategy === 'cost') {
    // 满足目标质量的最低成本;若无一达标,退而求其次选质量最高
    const eligible = scored.filter((s) => s.cap.quality >= target)
    const from = eligible.length > 0 ? eligible : scored
    chosen = from.reduce((a, b) => (b.cap.cost < a.cap.cost ? b : a))
  } else if (strategy === 'speed') {
    chosen = scored.reduce((a, b) => {
      if (b.cap.speed !== a.cap.speed) return b.cap.speed > a.cap.speed ? b : a
      if (b.cap.quality !== a.cap.quality) return b.cap.quality > a.cap.quality ? b : a
      return b.cap.cost < a.cap.cost ? b : a
    })
  } else {
    // balanced:质量档与目标差距最小,打平比成本低
    chosen = scored.reduce((a, b) => {
      const da = Math.abs(a.cap.quality - target)
      const db = Math.abs(b.cap.quality - target)
      if (db !== da) return db < da ? b : a
      return b.cap.cost < a.cap.cost ? b : a
    })
  }

  const cLabel = complexity === 'complex' ? '复杂' : complexity === 'medium' ? '中等' : '简单'
  const sLabel =
    strategy === 'quality' ? '质量优先' : strategy === 'cost' ? '成本优先' : strategy === 'speed' ? '速度优先' : '均衡'
  return {
    model: chosen.model,
    complexity,
    reason: `${cLabel}任务 · ${sLabel} → ${chosen.model}`
  }
}

/** Claude 模型档位候选,仅用于显式 Claude/Anthropic 类 Provider 的就近映射。 */
export const DEFAULT_AUTO_CANDIDATES = ['haiku', 'sonnet', 'opus']

export interface CrossRouteDecision {
  providerId: string
  providerName: string
  model: string
  reason: string
  complexity: Complexity
  /** 是否跨到了另一家厂商(调用方据此决定是否重建引擎) */
  switchedProvider: boolean
}

/**
 * 跨厂商智能路由:在**所有健康厂商 × 各自模型**的全集里按策略挑最优,
 * 而非局限在会话当前厂商的模型单里。打平时优先留在当前厂商
 * (避免无谓的引擎重建),再比成本。
 */
export function pickModelAcrossProviders(opts: {
  candidates: FailoverCandidate[]
  text: string
  strategy: SchedulerStrategy
  currentProviderId: string
}): CrossRouteDecision | null {
  const complexity = classifyComplexity(opts.text)
  const target = targetQuality(complexity)

  interface Entry {
    providerId: string
    providerName: string
    model: string
    cap: ModelCap
    isCurrent: boolean
  }
  const pool: Entry[] = []
  for (const c of opts.candidates) {
    if (!isProviderAvailable(c.id)) continue
    for (const model of c.models) {
      if (!model) continue
      pool.push({
        providerId: c.id,
        providerName: c.name,
        model,
        cap: capOf(model),
        isCurrent: c.id === opts.currentProviderId
      })
    }
  }
  if (pool.length === 0) return null

  // 比较器:返回 true 表示 b 优于 a。各策略主排序后,统一打平顺序:
  // 实测可靠性(自学习)> 留在当前厂商 > 成本更低。
  // 可靠性按 0.15 档量化打平,避免微小波动频繁改判(仍以质量档为主排序)。
  const relTier = (model: string): number => Math.round(reliabilityScore(model) / 0.15)
  const tieBreak = (a: Entry, b: Entry): boolean => {
    const ra = relTier(a.model)
    const rb = relTier(b.model)
    if (ra !== rb) return rb > ra
    if (a.isCurrent !== b.isCurrent) return b.isCurrent
    return b.cap.cost < a.cap.cost
  }
  let better: (a: Entry, b: Entry) => boolean
  if (opts.strategy === 'quality') {
    better = (a, b) => (b.cap.quality !== a.cap.quality ? b.cap.quality > a.cap.quality : tieBreak(a, b))
  } else if (opts.strategy === 'cost') {
    // 满足目标质量档的里面挑最便宜;无一达标则全量挑最便宜
    const eligible = pool.filter((e) => e.cap.quality >= target)
    const from = eligible.length > 0 ? eligible : pool
    pool.length = 0
    pool.push(...from)
    better = (a, b) => (b.cap.cost !== a.cap.cost ? b.cap.cost < a.cap.cost : tieBreak(a, b))
  } else if (opts.strategy === 'speed') {
    better = (a, b) => (b.cap.speed !== a.cap.speed ? b.cap.speed > a.cap.speed : tieBreak(a, b))
  } else {
    better = (a, b) => {
      const da = Math.abs(a.cap.quality - target)
      const db = Math.abs(b.cap.quality - target)
      if (db !== da) return db < da
      return tieBreak(a, b)
    }
  }
  const chosen = pool.reduce((a, b) => (better(a, b) ? b : a))

  const cLabel = complexity === 'complex' ? '复杂' : complexity === 'medium' ? '中等' : '简单'
  const sLabel =
    opts.strategy === 'quality'
      ? '质量优先'
      : opts.strategy === 'cost'
        ? '成本优先'
        : opts.strategy === 'speed'
          ? '速度优先'
          : '均衡'
  const switchedProvider = chosen.providerId !== opts.currentProviderId
  return {
    providerId: chosen.providerId,
    providerName: chosen.providerName,
    model: chosen.model,
    complexity,
    switchedProvider,
    reason: switchedProvider
      ? `${cLabel}任务 · ${sLabel} · 跨厂商 → ${chosen.providerName} / ${chosen.model}`
      : `${cLabel}任务 · ${sLabel} → ${chosen.model}`
  }
}

// ---------- 故障分类与跨厂商切换(M4.1) ----------

export interface FailoverCandidate {
  /** Provider id;新故障切换不再主动生成空 Provider 候选。 */
  id: string
  name: string
  models: string[]
}

export interface FailoverTarget {
  providerId: string
  name: string
  /** 目标厂商上与原模型能力档最接近的模型;无模型列表时为空 */
  model?: string
  /** 用户显式偏好命中时写入,供事件说明真实切换原因。 */
  preference?: string
}

export interface ProviderModelFailoverTarget {
  model: string
  preference?: string
}

const PROVIDER_MODEL_FAILOVER_FAILURES = new Set<FailureClass['kind']>([
  'model_unavailable',
  'rate_limit',
  'quota',
  'forbidden',
  'server'
])

/** Pick another model on the current Provider before crossing a Provider boundary. */
export function pickProviderModelFailoverTarget(opts: {
  providerId: string
  models: string[]
  desiredModel: string
  exclude: ReadonlySet<string>
  fallbackModel?: string
  failure: FailureClass
}): ProviderModelFailoverTarget | null {
  if (!opts.failure.switchable || !PROVIDER_MODEL_FAILOVER_FAILURES.has(opts.failure.kind)) return null
  if (!isProviderAvailable(opts.providerId)) return null

  const desiredModel = opts.desiredModel.trim()
  const candidates = [...new Set(opts.models.map((model) => model.trim()).filter(Boolean))]
    .filter((model) => model !== desiredModel && !opts.exclude.has(model))
  if (candidates.length === 0) return null

  const fallbackModel = opts.fallbackModel?.trim()
  if (fallbackModel && candidates.includes(fallbackModel)) {
    return { model: fallbackModel, preference: 'Configured fallback model' }
  }

  const desiredCap = capOf(desiredModel || 'sonnet')
  candidates.sort((left, right) => {
    const leftCap = capOf(left)
    const rightCap = capOf(right)
    const qualityDistance = Math.abs(leftCap.quality - desiredCap.quality) -
      Math.abs(rightCap.quality - desiredCap.quality)
    if (qualityDistance !== 0) return qualityDistance
    if (leftCap.cost !== rightCap.cost) return leftCap.cost - rightCap.cost
    if (leftCap.speed !== rightCap.speed) return rightCap.speed - leftCap.speed
    return left < right ? -1 : left > right ? 1 : 0
  })
  return { model: candidates[0], preference: 'Same-provider model recovery' }
}

/**
 * 挑选故障切换目标:排除已试过的厂商,跳过不健康厂商,
 * 在剩余候选里选"有与期望模型能力档最接近的模型"的一家(打平选成本低)。
 */
export function pickFailoverTarget(opts: {
  candidates: FailoverCandidate[]
  exclude: Set<string>
  desiredModel: string
  fallbackProviderId?: string
  fallbackModel?: string
}): FailoverTarget | null {
  const preferred = pickPreferredFailoverTarget(opts)
  if (preferred) return preferred
  // Explicit fallback settings are an authorization boundary. Do not silently
  // broaden them into an arbitrary healthy Provider when the requested target
  // is absent or unverified.
  if (opts.fallbackProviderId?.trim() || opts.fallbackModel?.trim()) return null

  const want = capOf(opts.desiredModel || 'sonnet').quality
  let best: { c: FailoverCandidate; model?: string; dist: number } | null = null
  for (const c of opts.candidates) {
    if (opts.exclude.has(c.id)) continue
    if (!isProviderAvailable(c.id)) continue
    let model: string | undefined
    let dist = 1 // 无模型列表:能力未知,给轻微劣势
    if (c.models.length > 0) {
      let bm = c.models[0]
      let bd = Number.POSITIVE_INFINITY
      let bc = 4
      for (const m of c.models) {
        const cap = capOf(m)
        const d = Math.abs(cap.quality - want)
        if (d < bd || (d === bd && cap.cost < bc)) {
          bm = m
          bd = d
          bc = cap.cost
        }
      }
      model = bm
      dist = bd
    }
    if (!best || dist < best.dist) best = { c, model, dist }
  }
  return best ? { providerId: best.c.id, name: best.c.name, model: best.model } : null
}

function pickPreferredFailoverTarget(opts: {
  candidates: FailoverCandidate[]
  exclude: Set<string>
  desiredModel: string
  fallbackProviderId?: string
  fallbackModel?: string
}): FailoverTarget | null {
  const fallbackProviderId = opts.fallbackProviderId?.trim()
  const fallbackModel = opts.fallbackModel?.trim()
  if (!fallbackProviderId && !fallbackModel) return null

  const healthyCandidates = opts.candidates.filter((c) => !opts.exclude.has(c.id) && isProviderAvailable(c.id))
  let preferredCandidates = healthyCandidates
  if (fallbackProviderId) {
    preferredCandidates = healthyCandidates.filter((c) => c.id === fallbackProviderId)
  } else if (fallbackModel) {
    // An explicit model is a frozen routing target. An empty catalog cannot
    // establish that the target exists, so keep the fallback fail-closed.
    preferredCandidates = healthyCandidates.filter((c) => c.models.includes(fallbackModel))
  }

  const candidate = preferredCandidates[0]
  if (!candidate) return null
  if (fallbackModel && !candidate.models.includes(fallbackModel)) return null

  return {
    providerId: candidate.id,
    name: candidate.name,
    model: fallbackModel || closestModel(candidate.models, opts.desiredModel),
    preference: '备用模型偏好'
  }
}

function closestModel(models: string[], desiredModel: string): string | undefined {
  if (models.length === 0) return undefined
  const want = capOf(desiredModel || 'sonnet').quality
  let best = models[0]
  let bestDist = Number.POSITIVE_INFINITY
  let bestCost = 4
  for (const model of models) {
    const cap = capOf(model)
    const dist = Math.abs(cap.quality - want)
    if (dist < bestDist || (dist === bestDist && cap.cost < bestCost)) {
      best = model
      bestDist = dist
      bestCost = cap.cost
    }
  }
  return best
}
