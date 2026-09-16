import type { EngineKind } from './types'

/** Optional explicit executor choice; absence preserves legacy model-led routing. */
export function normalizeSessionExecutorEngine(value: unknown): EngineKind | undefined {
  if (value === undefined) return undefined
  if (value === 'openai' || value === 'anthropic' || value === 'gemini') return value
  throw new Error('所选执行器尚未实现或能力未知，不能派发此任务。')
}

export function assertSessionExecutorEngine(expected: unknown, actual: unknown): void {
  const engine = normalizeSessionExecutorEngine(expected)
  if (engine && engine !== actual) throw new Error(`任务要求 ${engine} 执行器，当前连接使用 ${String(actual)}；请调整模型或连接。`)
}
