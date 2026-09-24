/**
 * 斜杠命令后端(纯逻辑,不碰热点文件)。
 *
 * 两件事:
 *  1. builtinSlashCommands —— 供命令面板补全 EastGenesis 内置命令。
 *  2. expandSlashCommand —— 发送时判定一条输入是不是本地斜杠命令。
 *
 * 设计取舍:
 *  - 内置命令由 EastGenesis 自己实现(清空/压缩/切模型/diff/回溯/帮助),不发给 Agent。
 *  - 未识别的斜杠输入按普通 prompt 发给当前原生引擎。
 */

/** 命令面板里展示 / 补全用的一条命令。 */
export interface SlashCommandInfo {
  name: string
  description: string
  /** 参数提示,如 "<model>";无参命令为 undefined。 */
  argHint?: string
  /** true=EastGenesis 本地处理;false=转交 SDK 作为 prompt。 */
  builtin: boolean
}

/** expandSlashCommand 结果:要么本地内置处理,要么当作普通 prompt(含转交 SDK 的斜杠命令)。 */
export type SlashCommandExpansion =
  | {
      kind: 'builtin'
      /** 内置命令名(不含前导斜杠),如 "model"。 */
      name: BuiltinCommandName
      /** 命令后的参数原文(已去首尾空白);无参为空串。 */
      args: string
    }
  | {
      kind: 'prompt'
      /** 要发送给 Agent 的文本(普通消息原文,或未识别的斜杠命令原文)。 */
      text: string
    }

export type BuiltinCommandName = 'clear' | 'compact' | 'model' | 'help' | 'diff' | 'rewind'

/** 内置命令表:name 唯一且不含前导斜杠。 */
const BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'clear', description: '清空当前会话的聊天记录,开始新的对话', builtin: true },
  { name: 'compact', description: '压缩上下文以释放窗口,保留关键信息', argHint: '[指示]', builtin: true },
  { name: 'model', description: '切换当前会话使用的模型', argHint: '<model>', builtin: true },
  { name: 'diff', description: '查看当前工作区相对基线的改动', builtin: true },
  { name: 'rewind', description: '回溯到较早的检查点(撤销文件改动)', builtin: true },
  { name: 'help', description: '列出可用的斜杠命令', builtin: true }
]

const BUILTIN_NAMES = new Set<string>(BUILTIN_COMMANDS.map((c) => c.name))

/**
 * 判定一条发送输入如何处理。
 *  - 不以 "/" 开头 → 普通消息(kind:"prompt")。
 *  - "/<builtin> [args]" → 本地内置处理(kind:"builtin")。
 *  - 其他以 "/" 开头→ 原文作为普通 prompt(kind:"prompt")。
 * 注意:仅裁决路由,不执行命令;内置命令的实际动作由调用方(主控接线)完成。
 */
export function expandSlashCommand(input: string): SlashCommandExpansion {
  const text = input ?? ''
  const trimmedStart = text.replace(/^\s+/, '')
  if (!trimmedStart.startsWith('/')) {
    return { kind: 'prompt', text }
  }
  // 取第一段作为命令名(斜杠后到首个空白),其余为参数
  const body = trimmedStart.slice(1)
  const match = body.match(/^(\S+)\s*([\s\S]*)$/)
  const name = (match?.[1] ?? '').toLowerCase()
  const args = (match?.[2] ?? '').trim()
  if (name && BUILTIN_NAMES.has(name)) {
    return { kind: 'builtin', name: name as BuiltinCommandName, args }
  }
  // 未识别的斜杠输入保留原文,由当前原生引擎处理。
  return { kind: 'prompt', text }
}

/** 只读的内置命令列表(供需要静态展示的调用方复用)。 */
export function builtinSlashCommands(): SlashCommandInfo[] {
  return [...BUILTIN_COMMANDS]
}
