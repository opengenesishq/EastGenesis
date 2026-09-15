export type SessionInputIntent = 'pause' | 'palace' | 'model' | 'message'

/** Exact commands only: quoted examples or larger requirements remain ordinary content. */
export function sessionInputIntent(text: string, hasAttachments = false): SessionInputIntent {
  if (hasAttachments) return 'message'
  const value = text.trim().replace(/[。！!\.]+$/, '').toLowerCase()
  if (/^(暂停(这个|当前)?任务|暂停一下|pause( this task)?)$/.test(value)) return 'pause'
  if (/^(去故宫(看看)?|打开故宫|切换到故宫|go to (the )?palace)$/.test(value)) return 'palace'
  if (/^(换(一)?个更快的模型|切换模型|换个模型|更换模型|change model|switch model)$/.test(value)) return 'model'
  return 'message'
}
