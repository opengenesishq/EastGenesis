export interface GoalRequestRequirement {
  id: string
  kind: 'page_count' | 'format' | 'sources' | 'constraint'
  /** Verbatim instruction fragment, never a model-generated interpretation. */
  text: string
  pageCount?: { value: number; operator: 'eq' | 'lte' | 'gte' }
  format?: 'pptx' | 'docx' | 'xlsx' | 'pdf'
}

const NUMBER = '(?:[1-9][0-9]{0,2}|[一二两三四五六七八九十百]{1,5}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'
const FORMAT = '(pptx?|docx?|xlsx?|pdf)'

/** Extract only explicit delivery instructions. Keep the complete objective in
 * the Goal contract as the authority for requirements this parser cannot prove. */
export function extractGoalRequestRequirements(objective: string): GoalRequestRequirement[] {
  const result: GoalRequestRequirement[] = []
  const add = (requirement: GoalRequestRequirement): void => {
    if (result.length < 100 && requirement.text.length <= 2_000 && !result.some(item => item.id === requirement.id)) result.push(requirement)
  }
  // Quoted source material is data, not a new requirement for the deliverable.
  const instructions = objective.replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, ' ')
  const clauses = instructions.split(/[，,。；;！!？?\n]/).map(text => text.trim()).filter(Boolean)
  for (const clause of clauses) {
    if (/^(?:例如|比如|示例|假设|原文|引用|for example\b|e\.g\.|source text\b)/i.test(clause)) continue
    const pageRules: Array<{ pattern: RegExp; operator: 'eq' | 'lte' | 'gte' }> = [
      { pattern: new RegExp(`(?:不超过|最多|至多|控制在|限制在|限定在)\\s*(${NUMBER})\\s*页(?:以内|内)?`, 'gi'), operator: 'lte' },
      { pattern: new RegExp(`(?:至少|不少于|最少)\\s*(${NUMBER})\\s*页`, 'gi'), operator: 'gte' },
      { pattern: new RegExp(`(?:正好|恰好|总共|共计|共|总计|一共|页数(?:为|是|设为))\\s*(${NUMBER})\\s*页`, 'gi'), operator: 'eq' },
      { pattern: new RegExp(`\\b(?:at most|no more than|up to|limit(?:ed)? to|within)\\s+(${NUMBER})[ -]+(?:pages?|slides?)\\b`, 'gi'), operator: 'lte' },
      { pattern: new RegExp(`\\b(?:at least|no fewer than)\\s+(${NUMBER})[ -]+(?:pages?|slides?)\\b`, 'gi'), operator: 'gte' },
      { pattern: new RegExp(`\\b(?:exactly|total(?: of)?)\\s+(${NUMBER})[ -]+(?:pages?|slides?)\\b`, 'gi'), operator: 'eq' },
      { pattern: new RegExp(`(?:做成|制作|生成|输出|提供|交付|写成|改为|缩为|压缩为|扩展为)\\s*(?:一份|一个|总共)?\\s*(${NUMBER})\\s*页`, 'gi'), operator: 'eq' },
      { pattern: new RegExp(`\\b(?:create|make|prepare|deliver|produce|write)\\s+(?:(?:a|an|the)\\s+)?(${NUMBER})[ -]+(?:page|slide)\\b`, 'gi'), operator: 'eq' }
    ]
    for (const { pattern, operator } of pageRules) {
      for (const match of clause.matchAll(pattern)) {
        if (negatedPrefix(clause, match.index!) || sourceDescription(clause, match.index!)) continue
        const value = parseRequirementNumber(match[1])
        if (value !== undefined) add({ id: `request:pages:${operator}:${value}`, kind: 'page_count', text: match[0], pageCount: { value, operator } })
      }
    }
    const formatRules = [
      new RegExp(`(?:生成|制作|输出|交付|提供|导出|保存|格式|转成|转换成|转换|改成|做成)(?:为|成|是|用)?\\s*(?:(?:一份|一个|可编辑的?|文件|格式|版本|[一二两三四五六七八九十\\d]+页)\\s*){0,3}${FORMAT}\\b`, 'gi'),
      new RegExp(`\\b(?:create|make|prepare|deliver|produce|export|save|convert|format)\\b\\s+(?:(?:a|an|the|as|to|in|editable|file|format)\\s+){0,4}${FORMAT}\\b`, 'gi')
    ]
    for (const pattern of formatRules) for (const match of clause.matchAll(pattern)) {
      if (negatedPrefix(clause, match.index!)) continue
      const raw = match[1].toLowerCase()
      const format = (raw === 'ppt' ? 'pptx' : raw === 'doc' ? 'docx' : raw === 'xls' ? 'xlsx' : raw) as GoalRequestRequirement['format']
      add({ id: `request:format:${format}`, kind: 'format', text: match[0], format })
    }
    const sourceRule = /(?:补充|补上|补|标注|注明|附上|给出|提供|保留|列出|带上).{0,12}(?:来源|出处|引用|参考文献)|(?:必须|需要|要求).{0,8}(?:来源|出处|引用)|\b(?:cite (?:the )?sources|include (?:the )?(?:sources|citations|references)|provide (?:the )?(?:sources|citations|references))\b/gi
    for (const match of clause.matchAll(sourceRule)) {
      if (!negatedPrefix(clause, match.index!)) add({ id: 'request:sources', kind: 'sources', text: match[0] })
    }
    if (/^(?:不要|不得|禁止|不能|不允许|仅使用|只使用|保留|不修改|do not\b|must not\b|only use\b|preserve\b)/i.test(clause)) {
      add({ id: `request:constraint:${result.filter(item => item.kind === 'constraint').length + 1}`, kind: 'constraint', text: clause })
    }
  }
  return result
}

function negatedPrefix(text: string, index: number): boolean {
  return /(?:不|无需|不要|不用|不必|禁止|不需要|不要求|not|don't|do not|without)\s*$/i.test(text.slice(0, index))
}

function sourceDescription(text: string, index: number): boolean {
  const prefix = text.slice(0, index)
  const lastOutput = Math.max(...['输出', '生成', '制作', '交付', '做成', '转成', '导出', '写成', '改成', '改为'].map(word => prefix.lastIndexOf(word)))
  if (lastOutput >= 0) return false
  return /已有|现有|原文|输入|阅读|参考|研究|分析|翻译|总结|\b(?:existing|input|source|read|summari[sz]e|translate)\b/i.test(prefix)
}

function parseRequirementNumber(text: string): number | undefined {
  const english = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  const word = english.indexOf(text.toLowerCase())
  if (word >= 0) return word + 1
  if (/^[1-9][0-9]{0,2}$/.test(text)) return Number(text)
  if (!/^(?:[一二两三四五六七八九]百)?(?:[一二两三四五六七八九]?十)?[一二两三四五六七八九]?$/.test(text)) return undefined
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let value = 0, current = 0
  for (const char of text) {
    if (char === '百' || char === '十') { value += (current || 1) * (char === '百' ? 100 : 10); current = 0 }
    else current = digits[char]
  }
  return value + current || undefined
}
