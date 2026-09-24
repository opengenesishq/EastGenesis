export type SessionInputIntent = 'pause' | 'model' | 'requirements' | 'message'

/** Exact commands only: quoted examples or larger requirements remain ordinary content. */
export function sessionInputIntent(text: string, hasAttachments = false): SessionInputIntent {
  if (hasAttachments) return 'message'
  const value = text.trim().replace(/[。！!\.]+$/, '').toLowerCase()
  if (/^(暂停(这个|当前)?任务|暂停一下|pause( this task)?)$/.test(value)) return 'pause'
  if (/^(换(一)?个更快的模型|切换模型|换个模型|更换模型|change model|switch model)$/.test(value)) return 'model'
  if (sessionRequirementRevisionText(text) !== undefined) return 'requirements'
  return 'message'
}

/** These commands only open a review. They never mutate a contract by themselves. */
export function sessionRequirementRevisionText(text: string): string | undefined {
  const value = text.trim().replace(/[。！!.]+$/, '')
  if (!value || /[?？]|(?:```|[“”「」『』])|^(?:例如|比如|示例|假设|请解释|为什么|如何|怎么|for example\b|why\b|how\b)/i.test(value)) return undefined
  const explicit = /^(?:修改|补充|更新|调整)(?:这个任务的|当前任务的)?(?:交付|验收)要求(?:\s*[:：]\s*([\s\S]+))?$/.exec(value)
  if (explicit) return explicit[1]?.trim() ?? ''
  const english = /^(?:change|update|revise|add) (?:the )?(?:delivery|acceptance) requirements(?:\s*:\s*([\s\S]+))?$/i.exec(value)
  if (english) return english[1]?.trim() ?? ''
  if (/^(?:请)?(?:把|将)?第[一二两三四五六七八九十百\d]+(?:页|张|段|节)(?:的)?(?:内容|标题|正文|结论|数据|图表)?\s*(?:补(?:上|充)?|增加|添加|标注|注明|改为|改成|替换为|删(?:除|掉))[\s\S]+$/.test(value) &&
    !/(?:吗|么|是否|能否|可不可以|是不是|怎么|如何|为什么|哪[里个些]|\b(?:should|would|could)\b)/i.test(value)) return value
  if (/^(?:please )?(?:add|include|cite|replace|change|remove|delete)\b[^?\n]+\b(?:on|in|from|of)\s+(?:page|slide|section)\s+\d+\b[^?\n]*$/i.test(value)) return value
  return undefined
}
