import baichuanLogoUrl from '../../../assets/provider-logos/baichuan-color.svg?url'
import baichuanTextLogoUrl from '../../../assets/provider-logos/baichuan-text.svg?url'
import baiduLogoUrl from '../../../assets/provider-logos/baidu-color.svg?url'
import baiduTextLogoUrl from '../../../assets/provider-logos/baidu-text.svg?url'
import claudeLogoUrl from '../../../assets/provider-logos/claude-color.svg?url'
import claudeTextLogoUrl from '../../../assets/provider-logos/claude-text.svg?url'
import deepseekLogoUrl from '../../../assets/provider-logos/deepseek-color.svg?url'
import deepseekTextLogoUrl from '../../../assets/provider-logos/deepseek-text.svg?url'
import doubaoLogoUrl from '../../../assets/provider-logos/doubao-color.svg?url'
import doubaoTextLogoUrl from '../../../assets/provider-logos/doubao-text.svg?url'
import geminiLogoUrl from '../../../assets/provider-logos/gemini-color.svg?url'
import geminiTextLogoUrl from '../../../assets/provider-logos/gemini-text.svg?url'
import grokLogoUrl from '../../../assets/provider-logos/grok.svg?url'
import grokTextLogoUrl from '../../../assets/provider-logos/grok-text.svg?url'
import kimiLogoUrl from '../../../assets/provider-logos/kimi-color.svg?url'
import kimiTextLogoUrl from '../../../assets/provider-logos/kimi-text.svg?url'
import metaLogoUrl from '../../../assets/provider-logos/meta-color.svg?url'
import metaTextLogoUrl from '../../../assets/provider-logos/meta-text.svg?url'
import minimaxLogoUrl from '../../../assets/provider-logos/minimax-color.svg?url'
import minimaxTextLogoUrl from '../../../assets/provider-logos/minimax-text.svg?url'
import mistralLogoUrl from '../../../assets/provider-logos/mistral-color.svg?url'
import mistralTextLogoUrl from '../../../assets/provider-logos/mistral-text.svg?url'
import ollamaLogoUrl from '../../../assets/provider-logos/ollama.svg?url'
import ollamaTextLogoUrl from '../../../assets/provider-logos/ollama-text.svg?url'
import openaiLogoUrl from '../../../assets/provider-logos/openai.svg?url'
import openaiTextLogoUrl from '../../../assets/provider-logos/openai-text.svg?url'
import qwenLogoUrl from '../../../assets/provider-logos/qwen-color.svg?url'
import qwenTextLogoUrl from '../../../assets/provider-logos/qwen-text.svg?url'
import sensenovaLogoUrl from '../../../assets/provider-logos/sensenova-color.svg?url'
import sensenovaTextLogoUrl from '../../../assets/provider-logos/sensenova-text.svg?url'
import sparkLogoUrl from '../../../assets/provider-logos/spark-color.svg?url'
import sparkTextLogoUrl from '../../../assets/provider-logos/spark-text.svg?url'
import stepfunLogoUrl from '../../../assets/provider-logos/stepfun-color.svg?url'
import stepfunTextLogoUrl from '../../../assets/provider-logos/stepfun-text.svg?url'
import yiLogoUrl from '../../../assets/provider-logos/yi-color.svg?url'
import yiTextLogoUrl from '../../../assets/provider-logos/yi-text.svg?url'
import zhipuLogoUrl from '../../../assets/provider-logos/zhipu-color.svg?url'
import zhipuTextLogoUrl from '../../../assets/provider-logos/zhipu-text.svg?url'

export interface ProviderLogoSpec {
  key: string
  label: string
  wordmark: string
  shortMark: string
  brandColor: string
  plateColor: string
  textColor: string
  cn: boolean
  known: boolean
  assetUrl?: string
  wordmarkAssetUrl?: string
  assetSource?: 'lobehub-icons-static-svg'
}

const UNKNOWN_LOGO: ProviderLogoSpec = {
  key: 'unknown',
  label: 'Agent',
  wordmark: 'AGENT',
  shortMark: 'AG',
  brandColor: '#8fe9ff',
  plateColor: '#101820',
  textColor: '#dce7f2',
  cn: false,
  known: false
}

const LOGOS: ProviderLogoSpec[] = [
  { key: 'openai', label: 'OpenAI', wordmark: 'OPENAI', shortMark: 'OA', brandColor: '#3fd0a8', plateColor: '#0d201b', textColor: '#dff8f0', cn: false, known: true, assetUrl: openaiLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'anthropic', label: 'Anthropic', wordmark: 'CLAUDE', shortMark: 'CL', brandColor: '#ff9d73', plateColor: '#2a1710', textColor: '#ffe3d6', cn: false, known: true, assetUrl: claudeLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'google', label: 'Google Gemini', wordmark: 'GEMINI', shortMark: 'GM', brandColor: '#6ea8ff', plateColor: '#101a2c', textColor: '#dce9ff', cn: false, known: true, assetUrl: geminiLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'xai', label: 'xAI Grok', wordmark: 'GROK', shortMark: 'GX', brandColor: '#b0b6c0', plateColor: '#181b20', textColor: '#eef1f4', cn: false, known: true, assetUrl: grokLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'meta', label: 'Meta Llama', wordmark: 'LLAMA', shortMark: 'LL', brandColor: '#5b9dff', plateColor: '#101c2e', textColor: '#dce9ff', cn: false, known: true, assetUrl: metaLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'mistral', label: 'Mistral', wordmark: 'MISTRAL', shortMark: 'MS', brandColor: '#ff8a52', plateColor: '#2b160d', textColor: '#ffe0cf', cn: false, known: true, assetUrl: mistralLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'qwen', label: 'Qwen', wordmark: 'QWEN', shortMark: 'QW', brandColor: '#a98fff', plateColor: '#17112d', textColor: '#efeaff', cn: true, known: true, assetUrl: qwenLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'deepseek', label: 'DeepSeek', wordmark: 'DEEPSEEK', shortMark: 'DS', brandColor: '#7d8dff', plateColor: '#101432', textColor: '#e2e6ff', cn: true, known: true, assetUrl: deepseekLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'doubao', label: 'Doubao', wordmark: 'DOUBAO', shortMark: 'DB', brandColor: '#5aa8ff', plateColor: '#0e1b2c', textColor: '#e1efff', cn: true, known: true, assetUrl: doubaoLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'baidu', label: 'ERNIE', wordmark: 'ERNIE', shortMark: 'BD', brandColor: '#4f7dff', plateColor: '#101832', textColor: '#e2eaff', cn: true, known: true, assetUrl: baiduLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'zhipu', label: 'GLM', wordmark: 'GLM', shortMark: 'GL', brandColor: '#7d95ff', plateColor: '#101638', textColor: '#e2e8ff', cn: true, known: true, assetUrl: zhipuLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'moonshot', label: 'Kimi', wordmark: 'KIMI', shortMark: 'KM', brandColor: '#5fe6d4', plateColor: '#0d2421', textColor: '#ddfbf7', cn: true, known: true, assetUrl: kimiLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'minimax', label: 'MiniMax', wordmark: 'MINIMAX', shortMark: 'MM', brandColor: '#ff7db0', plateColor: '#2b1020', textColor: '#ffe3ef', cn: true, known: true, assetUrl: minimaxLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'spark', label: 'iFlytek Spark', wordmark: 'SPARK', shortMark: 'XF', brandColor: '#ff6b5f', plateColor: '#2a1210', textColor: '#ffe1de', cn: true, known: true, assetUrl: sparkLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'yi', label: '01.AI Yi', wordmark: 'YI', shortMark: 'YI', brandColor: '#9de36b', plateColor: '#142411', textColor: '#ecffdf', cn: true, known: true, assetUrl: yiLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'baichuan', label: 'Baichuan', wordmark: 'BAICHUAN', shortMark: 'BC', brandColor: '#6fd6ff', plateColor: '#102330', textColor: '#dff6ff', cn: true, known: true, assetUrl: baichuanLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'sensenova', label: 'SenseNova', wordmark: 'SENSE', shortMark: 'SN', brandColor: '#ffcf5a', plateColor: '#2b220d', textColor: '#fff3cc', cn: true, known: true, assetUrl: sensenovaLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'stepfun', label: 'StepFun', wordmark: 'STEP', shortMark: 'SF', brandColor: '#b18cff', plateColor: '#1b1230', textColor: '#eee4ff', cn: true, known: true, assetUrl: stepfunLogoUrl, assetSource: 'lobehub-icons-static-svg' },
  { key: 'local', label: 'Local', wordmark: 'LOCAL', shortMark: 'LC', brandColor: '#aeb8c4', plateColor: '#151a21', textColor: '#eef2f6', cn: false, known: true, assetUrl: ollamaLogoUrl, assetSource: 'lobehub-icons-static-svg' }
]

const WORDMARK_ASSETS: Record<string, string> = {
  anthropic: claudeTextLogoUrl,
  baichuan: baichuanTextLogoUrl,
  baidu: baiduTextLogoUrl,
  deepseek: deepseekTextLogoUrl,
  doubao: doubaoTextLogoUrl,
  google: geminiTextLogoUrl,
  local: ollamaTextLogoUrl,
  meta: metaTextLogoUrl,
  minimax: minimaxTextLogoUrl,
  mistral: mistralTextLogoUrl,
  moonshot: kimiTextLogoUrl,
  openai: openaiTextLogoUrl,
  qwen: qwenTextLogoUrl,
  sensenova: sensenovaTextLogoUrl,
  spark: sparkTextLogoUrl,
  stepfun: stepfunTextLogoUrl,
  xai: grokTextLogoUrl,
  yi: yiTextLogoUrl,
  zhipu: zhipuTextLogoUrl
}

LOGOS.forEach((logo) => {
  logo.wordmarkAssetUrl = WORDMARK_ASSETS[logo.key]
})

const RULES: Array<{ match: RegExp; key: string }> = [
  { match: /deepseek|deepseek-chat|deepseek-reasoner|深度求索/i, key: 'deepseek' },
  { match: /qwen|通义|千问|dashscope|alibaba|aliyun|阿里|百炼|bailian/i, key: 'qwen' },
  { match: /doubao|豆包|bytedance|byte|volcengine|火山|方舟|ark/i, key: 'doubao' },
  { match: /moonshot|kimi|月之暗面/i, key: 'moonshot' },
  { match: /zhipu|chatglm|glm|bigmodel|智谱/i, key: 'zhipu' },
  { match: /baidu|ernie|文心|千帆|qianfan/i, key: 'baidu' },
  { match: /minimax|abab/i, key: 'minimax' },
  { match: /iflytek|xunfei|spark|星火|讯飞/i, key: 'spark' },
  { match: /01\.?ai|零一|yi-|yi_|yi\b|零一万物/i, key: 'yi' },
  { match: /baichuan|百川/i, key: 'baichuan' },
  { match: /sensenova|sensechat|sensetime|商汤|日日新/i, key: 'sensenova' },
  { match: /stepfun|step-|阶跃|step\b/i, key: 'stepfun' },
  { match: /openai|chatgpt|\bgpt\b|gpt-|o1|o3|o4/i, key: 'openai' },
  { match: /anthropic|claude|opus|sonnet|haiku/i, key: 'anthropic' },
  { match: /gemini|google|谷歌|palm|bard/i, key: 'google' },
  { match: /grok|xai|x\.ai/i, key: 'xai' },
  { match: /llama|meta/i, key: 'meta' },
  { match: /mistral|mixtral/i, key: 'mistral' },
  { match: /ollama|lm studio|lmstudio|local|localhost|127\.0\.0\.1|vllm/i, key: 'local' }
]

export const PROVIDER_LOGOS = LOGOS.reduce<Record<string, ProviderLogoSpec>>((acc, item) => {
  acc[item.key] = item
  return acc
}, {})

export function providerLogoKeyFor(values: Array<string | undefined | null>): string {
  const raw = values.filter(Boolean).join(' ').trim()
  if (!raw) return UNKNOWN_LOGO.key
  for (const rule of RULES) {
    if (rule.match.test(raw)) return rule.key
  }
  return UNKNOWN_LOGO.key
}

export function providerLogoFor(values: Array<string | undefined | null> | string): ProviderLogoSpec {
  const parts = Array.isArray(values) ? values : [values]
  const key = providerLogoKeyFor(parts)
  return PROVIDER_LOGOS[key] ?? UNKNOWN_LOGO
}
