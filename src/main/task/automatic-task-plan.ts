import type { TaskPlanDraftInput, TaskPlanStepInput } from '../../shared/task-plan-types'
import { decomposeTask } from '../agent/task-decomposer'
import { taskDagToPlanDraft } from './task-plan-dag'

const PROVIDER_EGRESS = '已选 Provider：目标、必要资料与上游步骤结果'

/** Local draft only. Approval, institution binding and dispatch remain with the existing coordinator. */
export async function createAutomaticTaskPlan(objective: string, cwd?: string): Promise<TaskPlanDraftInput> {
  // Engineering terms in a research topic or document are not a request to build software.
  if (requestsEngineering(objective)) {
    const result = await decomposeTask({ request: objective, cwd, useModel: false })
    return taskDagToPlanDraft(result.dag, result)
  }

  const research = /调研(?!报告|结果)|研究(?!报告|结果|结论|资料|论文|成果)|检索|搜集|收集.{0,12}(?:资料|来源)|查找.{0,12}(?:资料|来源)|\b(?:research(?!\s+(?:report|results|paper))|investigate|search for|find sources|gather sources)\b/i.test(objective)
  const analysis = /分析(?!报告|结果|结论)|计算(?!机)|统计(?!表)|测算|对比|比较|\b(?:analy[sz]e|calculate|compare)\b/i.test(objective)
  const document = requestsDocument(objective)
  const independentReview = /独立.{0,8}(?:复核|审查|核验)|交叉核验|\bindependent (?:review|verification)\b/i.test(objective)
  const steps: TaskPlanStepInput[] = []
  const externalAction = requestsExternalAction(objective)
  const add = (step: TaskPlanStepInput): void => {
    steps.push({ ...step, dependsOn: steps.length ? [steps[steps.length - 1].id] : [],
      dataEgress: step.dataEgress ?? [PROVIDER_EGRESS], estimatedCostUsd: null, riskLevel: step.riskLevel ?? 'low' })
  }
  if (research) add({
    id: 'research-sources', title: '收集资料与核对来源', workItemType: 'research', executionRole: 'general',
    description: '围绕原始目标检索或阅读已有资料，记录来源、日期和支持的结论；明确无来源、冲突和无法获取的内容。仅在关键资料缺失时追问，不编造引用。',
    expectedArtifacts: ['可追溯的来源清单、研究结论和资料缺口']
  })
  if (analysis) add({
    id: 'analyze-materials', title: '分析资料与整理结论', workItemType: 'analysis', executionRole: 'general',
    description: '使用已提供或上游取得的资料完成目标要求的分析、计算或比较；保留计算口径、依据、假设和不确定性，核对关键数字。',
    expectedArtifacts: ['有依据的分析结果、计算口径和结论']
  })
  if (document) add({
    id: 'prepare-deliverable', title: '制作并交付成果', workItemType: 'writing', executionRole: 'docs',
    description: '根据原始目标和已有资料制作成果，遵守指定的格式、页数、受众与内容要求；沿用已确认事实，标注来源，保护已有人工修改。检查实际文件能够打开或编辑，并交付文件及检查结果。',
    expectedArtifacts: ['符合目标格式和篇幅的可打开成果文件、来源及检查结果']
  })
  if (!steps.length) add({
    id: 'complete-request', title: '完成目标并交付结果', workItemType: 'custom', executionRole: 'general',
    description: '直接完成原始目标，复用已有上下文、资料和有效授权；关键资料缺失时追问。检查结果是否满足目标，并保留交付物、依据和未完成事项。',
    expectedArtifacts: ['目标要求的成果、完成说明与可核对依据']
  })
  if (independentReview) add({
    id: 'review-deliverable', title: '独立复核成果', workItemType: 'review', executionRole: 'review',
    description: '按用户要求独立检查上游成果及原始依据，记录问题、分歧与修订建议；复核意见不代替用户验收，也不授予额外权限。',
    expectedArtifacts: ['绑定上游成果的复核意见、问题和证据']
  })

  // External delivery is a separate requested effect, never implied by creating a document.
  if ((research || analysis || document) && externalAction) add({
    id: 'requested-action', title: '处理目标要求的后续操作', workItemType: 'operations', executionRole: 'general',
    riskLevel: 'high', dataEgress: [PROVIDER_EGRESS, '仅限目标明确要求且已有授权的外部接收方与成果内容'],
    description: '核对原始目标明确要求的发送、发布或其他外部操作，绑定实际成果版本、目标对象和已有授权。缺少信息或权限时保留准备成果并请求补充；操作结果未知时先核对实际状态，禁止重复执行。',
    expectedArtifacts: ['外部操作的实际回执，或待补信息、待授权及未知结果记录']
  })
  return {
    objective, steps,
    expectedArtifacts: [...new Set(steps.flatMap(step => step.expectedArtifacts ?? []))],
    dataEgress: [...new Set(steps.flatMap(step => step.dataEgress ?? []))], estimatedCostUsd: null,
    riskLevel: externalAction ? 'high' : 'low',
    acceptanceCriteria: [
      '成果符合原始目标指定的内容、格式、篇幅、受众和资料范围',
      '关键事实和数字有可核对依据，缺失资料及不确定性明确说明',
      '文件成果能够打开或编辑，已有人工内容和已确认事实得到保留',
      '只执行目标要求且已有授权的操作；明确报告未完成事项和未知结果'
    ],
    source: 'genesis'
  }
}

function requestsEngineering(text: string): boolean {
  return text.split(/[，。；;\n]|\b(?:and then|then)\b/i).some(clause => {
    const startsEngineering = /^(?:(?:请|帮我|完整|先|再|然后|并|并且|同时|\s)+)*(?:开发|实现|重构|修复|调试|构建|搭建)|^\s*(?:please\s+)?(?:implement|refactor|debug|fix|build\s+(?:an?\s+)?(?:app|website|api))\b/i.test(clause)
    if (requestsDocument(clause) && !startsEngineering) return false
    return /(?:开发|实现|重构|修复|调试|编写|修改|构建|搭建).{0,24}(?:代码|程序|脚本|软件|应用|网站|网页|前端|后端|组件|接口|数据库|登录|认证|功能|\b(?:API|IPC|UI|bug)\b)/i.test(clause)
      || /(?:代码|程序|软件|前端|后端|组件|接口|数据库|\b(?:API|IPC|bug)\b).{0,16}(?:重构|修复|调试|改造|实现)/i.test(clause)
      || /\b(?:implement|refactor|debug)\b|\b(?:build|develop|create|write|modify|fix)\b.{0,40}\b(?:app|application|website|webpage|software|script|code|component|frontend|backend|api|database|login|bug)\b/i.test(clause)
  })
}

function requestsDocument(text: string): boolean {
  const artifact = /汇报|报告|演示|幻灯片|文稿|文档|文案|文章|策划书|计划书|表格|图表|\b(?:report|presentation|slides?|document|spreadsheet|chart|pptx?|docx?|xlsx?|pdf)\b/i
  if (!artifact.test(text)) return false
  return /生成|制作|创建|编写|撰写|写成|整理成|做成|转成|转换|汇总成|给出|输出|交付|导出|修改|更新|补充|\b(?:create|make|build|write|draft|prepare|produce|deliver|export|convert|edit|update)\b/i.test(text)
    || /^(?:请|帮我|给我|需要|一份|一个|\s)*(?:[一二三四五六七八九十\d]+页)?(?:客户)?(?:汇报|报告|演示|幻灯片|文稿|文档|文案|表格|图表)/.test(text)
}

function requestsExternalAction(text: string): boolean {
  return /发送|发给|发到|寄给|发布|部署|推送|上传|删除|购买|支付|预约|\b(?:send|publish|deploy|push|upload|delete|purchase|pay)\b|\bemail\b.{0,30}\bto\b/i.test(text)
}
