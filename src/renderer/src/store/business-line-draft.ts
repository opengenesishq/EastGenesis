import type { AgentDeskApi } from '../../../shared/types'
import { generateNativeDraft } from '../lib/nativeDraft'
import { parseBusinessLine, type BusinessLineDefinition } from '../../../shared/business-line-types'

const DRAFT_FIELDS = new Set(['name', 'objective', 'workflow', 'deliverables', 'routingPreference', 'taskBudgetUsd', 'requiredCapabilities', 'acceptanceCriteria', 'roleInstructions', 'toolScope', 'workSurfaces'])

export function parseBusinessLineDraft(text: string, id: string): BusinessLineDefinition {
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim()
  const value: unknown = JSON.parse(cleaned)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型返回的草稿不是 JSON 对象')
  if (Object.keys(value).some((key) => !DRAFT_FIELDS.has(key))) throw new Error('模型返回了业务线草稿不支持的字段')
  const draft = parseBusinessLine({ ...value, schemaVersion: 1, id, origin: 'custom', enabled: true, order: 0 })
  if (!draft) throw new Error('模型草稿未通过结构校验；可以重新生成或手工填写')
  return draft
}

/** Uses the normal assistant runtime and returns only a validated, editable draft. */
export async function generateBusinessLineDraft(api: AgentDeskApi, description: string): Promise<{ draft: BusinessLineDefinition; sessionId: string }> {
  if (!description.trim()) throw new Error('请描述想创建的业务线')
  const prompt = [
    '请根据以下需求生成业务线配置草稿。不要调用工具，只返回一个 JSON 对象，不要 Markdown 或解释。',
    '必填字段：name（名称）、objective（目标）、workflow（步骤字符串数组）、deliverables（成果字符串数组）、routingPreference（balanced/quality/cost/speed）。',
    '可选字段：roleInstructions（字符串）、acceptanceCriteria（字符串数组）、taskBudgetUsd（正数USD）、requiredCapabilities（仅tools/vision数组）、toolScope（view/plan/execute）。不要返回ID、连接信息或密钥。不确定的可选字段省略。',
    '可选 workSurfaces 为 tasks/results/video 的非空数组，默认任务与成果；需求涉及视频制作时可加入 video。',
    description.trim()
  ].join('\n\n')
  const result = await generateNativeDraft(api, { prompt, title: '业务线配置草稿', businessLineId: 'assistant' })
  return { draft: parseBusinessLineDraft(result.text, `business-line:${crypto.randomUUID()}`), sessionId: result.sessionId }
}
