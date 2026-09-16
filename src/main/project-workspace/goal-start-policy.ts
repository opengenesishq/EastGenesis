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
    reason: '翻译、解释、摘要、文案草稿和建议直接进入只读对话；文件交付和外部操作仍需单独安排。' }
}

function isSingleReadOnlyRequest(text: string): boolean {
  const request = text.replace(/^(?:(?:请|帮我|给我|麻烦|可以|能否)\s*)+/, '').replace(/^(?:(?:please|can you|could you)\s+)+/i, '')
    .replace(/^write(?=\s+(?:(?:a|an|the|some)\s+)?(?:email|reply|response|paragraph|copy|outline|subject|slogan|text)\b)/i, 'draft')
  const instruction = withoutQuotedSource(request)
  // Keep the complete request at the engine boundary. This classifier only
  // selects the start strategy, and never discards a requested follow-up action.
  if (/(?:写入|修改|更改|删除|移除|重构|开发|实现|提交|推送|发布|部署|安装|执行|运行|发送|发出|发给|发到|发至|寄给|寄出|转发|购买|支付|预约|批准|签署|自动化|调度|接入|批量|补丁|测试|下载|上传|然后|并且|接着|之后|保存|导出|\b(?:modify|delete|remove|refactor|implement|commit|push|publish|deploy|install|execute|run|send|forward|purchase|pay|book|approve|sign|automate|schedule|batch|patch|test|download|upload|then|save|export)\b)/i.test(instruction)) return false
  if (/(?:并|然后|接着|顺便|再|同时)\s*通知|\b(?:and|then|also)\s+notify\b/i.test(instruction)) return false
  // A request for an editable/exported artifact must retain its full workflow;
  // a chat response must not silently replace that deliverable.
  if (/(?:汇报|演示文稿|幻灯片|表格|图表|绘制|\b(?:report|presentation|slides?|spreadsheet|chart|pptx?|pdf|docx?|xlsx?)\b)/i.test(instruction)) return false
  if (/(?:文件|文档|代码|网页|网站|\b(?:file|document|code|website)\b)/i.test(instruction) &&
      !/^(?:翻译|解释|说明|什么是|总结|概括|摘要|提炼|translate\b|explain\b|summari[sz]e\b|what (?:is|are)\b)/i.test(instruction)) return false
  if (/(?:生成|创建|\b(?:generate|create|write|edit)\b)/i.test(instruction)) return false
  return /^(?:翻译|解释|说明|什么是|总结|概括|摘要|提炼|润色|改写|头脑风暴|translate\b|explain\b|summari[sz]e\b|rewrite\b|brainstorm\b|what (?:is|are)\b)/i.test(instruction) ||
    /^把[^\r\n：:]{1,120}(?:翻译|总结|概括|润色|改写)/.test(instruction) ||
    /^(?:起草|草拟|撰写|写)(?:[^\r\n：:]{0,80})(?:邮件|回信|回复|文案|段落|开场白|提纲|标题|标语|口号|草稿)/.test(instruction) ||
    /^(?:列出|给出|提供)(?:[^\r\n：:]{0,80})(?:建议|思路|想法|标题)/.test(instruction) ||
    /^draft\s+(?:(?:a|an|the|some)\s+)?(?:email|reply|response|paragraph|copy|outline|subject|slogan|text)\b/i.test(instruction)
}

/** Ignore only an explicitly quoted source, never arbitrary text after a colon. */
function withoutQuotedSource(request: string): string {
  if (!/^(?:翻译|总结|概括|摘要|提炼|润色|改写|translate\b|summari[sz]e\b|rewrite\b)/i.test(request)) return request
  const separator = request.search(/[：:]/)
  if (separator < 0) return request
  const source = request.slice(separator + 1).trim()
  const quoted = /^(?:“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|```[^`]*```)\s*$/.test(source)
  return quoted ? request.slice(0, separator).trim() : request
}
