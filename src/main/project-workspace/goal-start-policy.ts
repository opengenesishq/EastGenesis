import type { ProjectGoalTaskStartDecision, ProjectGoalTaskStartInput } from '../../shared/project-workspace-types'

/** Classification reduces the workflow; the actual view strategy still enforces read-only tools. */
export function decideProjectGoalStart(input: ProjectGoalTaskStartInput, alreadyPrepared = false): ProjectGoalTaskStartDecision {
  const plan = (reason: string): ProjectGoalTaskStartDecision => ({
    schemaVersion: 1, mode: input.mode, kind: 'plan', taskStrategy: 'plan', reason
  })
  if (input.mode === 'plan') return plan('用户选择先准备计划。')
  if (input.template !== 'auto') return plan('任务模板包含多个交付步骤，需要先准备计划。')
  if (alreadyPrepared || input.legacySessionId || input.legacyCreationClaimed) return plan('沿用已有任务及计划，恢复入口不会自动启动执行。')
  const text = input.objective.trim()
  if (text.length > 8_000 || !isSingleReadOnlyRequest(text)) return plan('此任务需要分解、资料核对或产生修改，先准备可审查计划。')
  return { schemaVersion: 1, mode: input.mode, kind: 'direct', taskStrategy: 'view',
    reason: '简单翻译、解释或摘要直接进入只读对话，文件修改和外部操作仍受禁止。' }
}

function isSingleReadOnlyRequest(text: string): boolean {
  if (/(?:写入|修改|更改|删除|移除|重构|生成|创建|开发|实现|提交|推送|发布|部署|安装|执行|运行|发送|转发|购买|支付|预约|批准|自动化|调度|接入|批量|补丁|测试|汇报|演示文稿|表格|图表|绘制|下载|上传|然后|并且|接着|之后|保存|导出|\b(?:write|edit|modify|delete|remove|refactor|generate|create|implement|commit|push|publish|deploy|install|execute|run|send|forward|purchase|pay|book|approve|automate|schedule|batch|patch|test|download|upload|then|save|export|pptx?|pdf|docx?|xlsx?)\b)/i.test(text)) return false
  const request = text.replace(/^(?:(?:请|帮我|给我|麻烦|可以|能否)\s*)+/, '').replace(/^(?:(?:please|can you|could you)\s+)+/i, '')
  return /^(?:翻译|解释|说明|什么是|总结|概括|摘要|提炼|translate\b|explain\b|summari[sz]e\b|what (?:is|are)\b)/i.test(request) ||
    /^把[^\r\n：:]{1,120}(?:翻译|总结|概括)/.test(request)
}
