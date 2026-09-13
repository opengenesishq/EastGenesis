/**
 * 厂商 → 外观皮肤映射,供控制室工位/工牌主题化。
 *
 * 纯逻辑,无 JSX、无 three 依赖:只返回颜色字符串与文字标识,渲染层自行消费。
 * 名称是用户自定义自由文本,按关键词大小写不敏感匹配;命中不了给中性灰皮肤。
 * 说明:仅用品牌线索映射出的抽象配色 + 短代码徽记,不内置任何厂商商标图形。
 *
 * 配色遵循办公区规范:机器人保持统一银黑机身,厂商身份只进铭牌/logo。
 * 避免把 provider/model 映射成整套彩色"衣服",否则办公区会重新变花。
 */

export interface VendorSkin {
  /** 机器人外壳主色(meshStandardMaterial.color,非发光) */
  bodyColor: string
  /** 机器人护甲/工装面板色,用于区别不同 provider/model 的"衣服" */
  shellColor: string
  /** 发光/强调色(emissive 用,配合 Bloom;渲染侧记得 toneMapped={false}) */
  accent: string
  /** 徽记:短代码或首字母,用于工牌/头顶标识;不是厂商 logo */
  emblem: string
  /** 人类可读厂商标签 */
  label: string
}

const NEUTRAL_BODY = '#17202a'
const NEUTRAL_SHELL = '#d7dee5'
const NEUTRAL_ACCENT = '#59dcff'

function neutralSkin(emblem: string, label: string): VendorSkin {
  return {
    bodyColor: NEUTRAL_BODY,
    shellColor: NEUTRAL_SHELL,
    accent: NEUTRAL_ACCENT,
    emblem,
    label
  }
}

/**
 * 已知厂商皮肤表(named 导出,便于外部枚举/测试)。
 * emblem 是兜底短代码;真实厂商识别由 ProviderLogoBadge 贴到胸牌/铭牌上。
 */
export const VENDOR_SKINS: Record<string, VendorSkin> = {
  anthropic: neutralSkin('AN', 'Anthropic'),
  openai: neutralSkin('OA', 'OpenAI'),
  google: neutralSkin('GO', 'Google'),
  qwen: neutralSkin('QW', 'Qwen'),
  deepseek: neutralSkin('DS', 'DeepSeek'),
  doubao: neutralSkin('DB', 'Doubao'),
  baidu: neutralSkin('BD', 'ERNIE'),
  kimi: neutralSkin('KM', 'Kimi'),
  zhipu: neutralSkin('GL', '智谱 GLM'),
  minimax: neutralSkin('MM', 'MiniMax'),
  spark: neutralSkin('XF', '讯飞星火'),
  yi: neutralSkin('YI', '零一万物'),
  baichuan: neutralSkin('BC', '百川'),
  sensenova: neutralSkin('SN', '商汤日日新'),
  stepfun: neutralSkin('SF', '阶跃星辰'),
  grok: neutralSkin('GX', 'Grok'),
  meta: neutralSkin('MT', 'Meta'),
  mistral: neutralSkin('MS', 'Mistral'),
  default: neutralSkin('AG', 'Agent')
}

/** 名称关键词 → 皮肤键;顺序即优先级 */
const RULES: Array<{ match: RegExp; key: keyof typeof VENDOR_SKINS }> = [
  { match: /openai|gpt|o1|o3|o4|chatgpt/i, key: 'openai' },
  { match: /anthropic|claude|opus|sonnet|haiku|官方|official/i, key: 'anthropic' },
  { match: /gemini|google|谷歌|palm|bard/i, key: 'google' },
  { match: /deepseek|深度求索/i, key: 'deepseek' },
  { match: /doubao|豆包|bytedance|byte|volcengine|火山|方舟|ark/i, key: 'doubao' },
  { match: /baidu|ernie|文心|千帆|qianfan/i, key: 'baidu' },
  { match: /moonshot|kimi|月之暗面/i, key: 'kimi' },
  { match: /zhipu|glm|智谱|bigmodel/i, key: 'zhipu' },
  { match: /qwen|通义|千问|alibaba|阿里|bailian|百炼/i, key: 'qwen' },
  { match: /minimax|abab/i, key: 'minimax' },
  { match: /iflytek|xunfei|spark|星火|讯飞/i, key: 'spark' },
  { match: /01\.?ai|零一|yi-|yi_|yi\b|零一万物/i, key: 'yi' },
  { match: /baichuan|百川/i, key: 'baichuan' },
  { match: /sensenova|sensechat|sensetime|商汤|日日新/i, key: 'sensenova' },
  { match: /stepfun|step-|阶跃|step\b/i, key: 'stepfun' },
  { match: /grok|xai/i, key: 'grok' },
  { match: /llama|meta/i, key: 'meta' },
  { match: /mistral/i, key: 'mistral' }
]

/** 按厂商名称返回皮肤键(deepseek/openai…),供 3D 吉祥物分派;空/未命中=default */
export function vendorKeyFor(name?: string): string {
  const raw = (name ?? '').trim()
  if (!raw) return 'default'
  for (const { match, key } of RULES) {
    if (match.test(raw)) return key
  }
  return 'default'
}

/**
 * 按厂商名称返回外观皮肤。
 * @param name Provider 名称(自由文本);为空/未命中已知厂商时使用中性灰皮肤。
 */
export function vendorSkin(name?: string): VendorSkin {
  const raw = (name ?? '').trim()
  if (!raw) return VENDOR_SKINS.default
  for (const { match, key } of RULES) {
    if (match.test(raw)) return VENDOR_SKINS[key]
  }
  // 未命中:中性皮肤,徽记取名称首字母/首字(去符号,最多 2 字)
  const first = raw.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()
  return {
    ...VENDOR_SKINS.default,
    emblem: first || VENDOR_SKINS.default.emblem,
    label: raw
  }
}
