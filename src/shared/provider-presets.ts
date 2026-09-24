import type { EngineKind, OpenAIProtocol } from './types'

/** Connection templates only. Account access and model availability are discovered at setup. */
export interface ProviderPreset {
  key: string
  label: string
  baseUrl: string
  models: string[]
  engine: EngineKind
  hint: string
  openaiProtocol?: OpenAIProtocol
  vendor?: string
  category?: 'official' | 'aggregator' | 'gateway' | 'local'
  region?: 'global' | 'china' | 'local'
  billing?: 'metered' | 'subscription' | 'free-tier' | 'local'
  auth?: 'api-key' | 'oauth' | 'none'
  searchTerms?: string[]
  /** Public console link; never contains an affiliate code, credential, or account identifier. */
  apiKeyUrl?: string
  docsUrl?: string
  /** Managed credential names are applied through the existing credential broker. */
  credentialHeaderNames?: string[]
  /** Resource-specific or self-hosted endpoints need user input, unlike fixed official endpoints. */
  requiresBaseUrl?: boolean
  baseUrlPlaceholder?: string
  /** No standard model-list endpoint, or models are resource-specific deployment names. */
  requiresModelId?: boolean
}

type PresetInput = Omit<ProviderPreset, 'models'> & { models?: string[] }

function preset(input: PresetInput): ProviderPreset {
  return {
    category: 'official',
    region: 'global',
    billing: 'metered',
    auth: 'api-key',
    models: [],
    credentialHeaderNames: input.auth === 'none' ? [] : [input.engine === 'anthropic'
      ? 'x-api-key' : input.engine === 'gemini' ? 'x-goog-api-key' : 'authorization'],
    ...input
  }
}

/**
 * Borrow CC Switch's connection-template approach, not its CLI-specific configuration or promotions.
 * Reference: farion1231/cc-switch @ 06082e189d65e6d6dbadc35dacdac1ce6c79d89a.
 * Default to live model discovery. Fixed names below are documented fallbacks for services without
 * a standard model-list API, not a promise that the user's account has access to those models.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  preset({
    key: 'caogen-relay', label: 'CaoGen 中转站', vendor: 'CiYuan2API',
    baseUrl: 'https://ciyuan2api.com', engine: 'openai', openaiProtocol: 'chat',
    category: 'gateway', region: 'china', apiKeyUrl: 'https://ciyuan2api.com/console/token',
    hint: '填写自己的 API Key，自动获取账户可用模型；地址与协议已预填。',
    searchTerms: ['次元', 'ciyuan', '中转', 'relay']
  }),
  preset({
    key: 'openai', label: 'OpenAI', vendor: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1', engine: 'openai', openaiProtocol: 'responses',
    apiKeyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://platform.openai.com/docs/api-reference/responses',
    hint: '使用官方 Responses API。填写 API Key 后自动获取可用模型。'
  }),
  preset({
    key: 'anthropic', label: 'Anthropic / Claude', vendor: 'Anthropic',
    baseUrl: 'https://api.anthropic.com', engine: 'anthropic',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys', docsUrl: 'https://docs.anthropic.com/en/api/overview',
    hint: '使用官方 Messages API。填写 API Key 后自动获取可用模型。',
    searchTerms: ['claude', '克劳德']
  }),
  preset({
    key: 'gemini', label: 'Google Gemini', vendor: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', engine: 'gemini',
    apiKeyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    hint: '使用 Gemini 原生 API。填写 Google AI Studio API Key 后获取可用模型。',
    searchTerms: ['谷歌', 'google', 'gemini', 'aistudio']
  }),
  preset({
    key: 'deepseek-chat', label: 'DeepSeek', vendor: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com', engine: 'openai', openaiProtocol: 'chat', region: 'china',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/',
    hint: '使用官方 OpenAI 兼容 API。填写 API Key 后获取账户可用模型。',
    searchTerms: ['深度求索', 'deepseek']
  }),
  preset({
    key: 'deepseek', label: 'DeepSeek · Anthropic 兼容', vendor: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic', engine: 'anthropic', region: 'china',
    credentialHeaderNames: ['authorization'],
    apiKeyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/guides/anthropic_api',
    hint: '使用 DeepSeek 官方 Anthropic 兼容端点，沿用 DeepSeek API Key。',
    searchTerms: ['深度求索', 'messages']
  }),
  preset({
    key: 'kimi', label: 'Kimi / 月之暗面', vendor: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/anthropic', engine: 'anthropic', region: 'china',
    credentialHeaderNames: ['authorization'],
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys', docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    hint: '使用 Moonshot 官方 Anthropic 兼容端点，填写开放平台 API Key。',
    searchTerms: ['月之暗面', 'moonshot', 'kimi']
  }),
  preset({
    key: 'glm', label: '智谱 GLM', vendor: 'Zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic', engine: 'anthropic', region: 'china',
    credentialHeaderNames: ['authorization'],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys', docsUrl: 'https://docs.bigmodel.cn/',
    hint: '使用智谱官方 Anthropic 兼容端点；模型与账户权限以平台实际返回为准。',
    searchTerms: ['智谱', '清言', 'bigmodel', 'zhipu']
  }),
  preset({
    key: 'glm-global', label: 'Z.AI / GLM · 国际', vendor: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/anthropic', engine: 'anthropic', credentialHeaderNames: ['authorization'],
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list', docsUrl: 'https://docs.z.ai/',
    hint: '使用 Z.AI 国际平台的 API Key；与智谱国内平台的账户和额度分别管理。',
    searchTerms: ['智谱', 'glm', 'zai', '国际']
  }),
  preset({
    key: 'qwen', label: '通义千问 / 阿里百炼', vendor: 'Alibaba Cloud',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', engine: 'openai', openaiProtocol: 'chat', region: 'china',
    apiKeyUrl: 'https://bailian.console.aliyun.com/', docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    hint: '使用百炼北京地域 API Key。已预填兼容地址；专属业务空间地址可在连接详情中修改。',
    searchTerms: ['qwen', '千问', '通义', '百炼', 'dashscope', '阿里']
  }),
  preset({
    key: 'qwen-global', label: 'Qwen / 百炼 · 国际', vendor: 'Alibaba Cloud',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', engine: 'openai', openaiProtocol: 'chat',
    apiKeyUrl: 'https://modelstudio.console.alibabacloud.com/', docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    hint: '使用百炼新加坡地域 API Key，不能与北京地域密钥混用。专属业务空间地址可在连接详情修改。',
    searchTerms: ['通义', '阿里', 'dashscope', '新加坡', 'singapore']
  }),
  preset({
    key: 'minimax', label: 'MiniMax · 国内', vendor: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/anthropic', engine: 'anthropic', region: 'china',
    models: ['MiniMax-M3'],
    apiKeyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-anthropic-api',
    hint: '使用 MiniMax 国内平台 API Key。内置官方文档模型作为发现失败时的备选，额度以账户为准。',
    searchTerms: ['minimaxi', '海螺', '稀宇']
  }),
  preset({
    key: 'minimax-global', label: 'MiniMax · 国际', vendor: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic', engine: 'anthropic', models: ['MiniMax-M3'],
    apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-anthropic-api',
    hint: '使用 MiniMax 国际平台 API Key；与国内平台密钥、余额分别管理。',
    searchTerms: ['minimax', 'international', '国际']
  }),
  preset({
    key: 'doubao', label: '豆包 / 火山方舟', vendor: 'Volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', engine: 'openai', openaiProtocol: 'chat', region: 'china',
    requiresModelId: true,
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', docsUrl: 'https://www.volcengine.com/docs/82379/1330626',
    hint: '填写方舟 API Key，模型填写已开通的模型 ID 或推理接入点 ID；地址与协议已预填。',
    searchTerms: ['字节', 'doubao', 'ark', '方舟', '火山']
  }),
  preset({
    key: 'grok', label: 'Grok / xAI', vendor: 'xAI',
    baseUrl: 'https://api.x.ai/v1', engine: 'openai', openaiProtocol: 'chat',
    apiKeyUrl: 'https://console.x.ai/', docsUrl: 'https://docs.x.ai/docs/api-reference',
    hint: '使用 xAI 官方 API Key，自动获取账户可用模型。', searchTerms: ['grok', 'xai']
  }),
  preset({
    key: 'openrouter', label: 'OpenRouter', vendor: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1', engine: 'openai', openaiProtocol: 'chat', category: 'aggregator',
    apiKeyUrl: 'https://openrouter.ai/keys', docsUrl: 'https://openrouter.ai/docs/quickstart',
    hint: '统一接入多家模型。填写 OpenRouter API Key 后获取模型目录。',
    searchTerms: ['聚合', '路由', 'router']
  }),
  preset({
    key: 'siliconflow', label: '硅基流动 · 国内', vendor: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1', engine: 'openai', openaiProtocol: 'chat', category: 'aggregator', region: 'china',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak', docsUrl: 'https://docs.siliconflow.cn/',
    hint: '使用硅基流动国内平台 API Key，自动获取已上架模型。',
    searchTerms: ['siliconflow', '硅基', '开源']
  }),
  preset({
    key: 'siliconflow-global', label: 'SiliconFlow · 国际', vendor: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1', engine: 'openai', openaiProtocol: 'chat', category: 'aggregator',
    apiKeyUrl: 'https://cloud.siliconflow.com/account/ak', docsUrl: 'https://docs.siliconflow.com/',
    hint: '使用硅基流动国际平台 API Key；国际与国内目录、账户可能不同。',
    searchTerms: ['硅基流动', 'international', '国际']
  }),
  preset({
    key: 'groq', label: 'Groq', vendor: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1', engine: 'openai', openaiProtocol: 'chat',
    apiKeyUrl: 'https://console.groq.com/keys', docsUrl: 'https://console.groq.com/docs/openai',
    hint: '使用 Groq 官方 API Key，自动获取可用模型；速率与额度以账户为准。',
    searchTerms: ['高速', 'llama', 'groq']
  }),
  preset({
    key: 'mistral', label: 'Mistral AI', vendor: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1', engine: 'openai', openaiProtocol: 'chat',
    apiKeyUrl: 'https://console.mistral.ai/api-keys', docsUrl: 'https://docs.mistral.ai/getting-started/quickstart',
    hint: '使用 Mistral 官方 API Key，自动获取账户可用模型。', searchTerms: ['codestral', 'mistral']
  }),
  preset({
    key: 'together', label: 'Together AI', vendor: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1', engine: 'openai', openaiProtocol: 'chat', category: 'aggregator',
    apiKeyUrl: 'https://api.together.ai/settings/api-keys', docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
    hint: '使用 Together AI API Key，自动获取平台模型目录。', searchTerms: ['开源', 'llama', 'qwen']
  }),
  preset({
    key: 'fireworks', label: 'Fireworks AI', vendor: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1', engine: 'openai', openaiProtocol: 'chat', category: 'aggregator',
    apiKeyUrl: 'https://fireworks.ai/account/api-keys', docsUrl: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
    hint: '使用 Fireworks AI API Key，模型或部署 ID 以账户控制台为准。', searchTerms: ['开源', 'serverless', '部署']
  }),
  preset({
    key: 'perplexity', label: 'Perplexity / Sonar', vendor: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai/chat/completions', engine: 'openai', openaiProtocol: 'chat',
    models: ['sonar'], requiresModelId: true,
    apiKeyUrl: 'https://www.perplexity.ai/account/api/keys', docsUrl: 'https://docs.perplexity.ai/',
    hint: '使用 Sonar API Key，已预填官方文档模型 sonar。可在连接详情中改为账户支持的其他 Sonar 模型。',
    searchTerms: ['联网', '搜索', 'sonar', 'search']
  }),
  preset({
    key: 'baichuan', label: '百川智能', vendor: 'Baichuan',
    baseUrl: 'https://api.baichuan-ai.com/v1', engine: 'openai', openaiProtocol: 'chat', region: 'china',
    requiresModelId: true, apiKeyUrl: 'https://platform.baichuan-ai.com/console/apikey', docsUrl: 'https://platform.baichuan-ai.com/docs/api',
    hint: '使用百川开放平台 API Key，模型 ID 以账户控制台为准。', searchTerms: ['baichuan', '百川']
  }),
  preset({
    key: 'azure-openai', label: 'Azure OpenAI', vendor: 'Microsoft Azure',
    baseUrl: '', baseUrlPlaceholder: 'https://your-resource.openai.azure.com/openai/v1',
    engine: 'openai', openaiProtocol: 'responses', credentialHeaderNames: ['api-key'],
    requiresBaseUrl: true, requiresModelId: true,
    apiKeyUrl: 'https://ai.azure.com/', docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints',
    hint: '填写自己资源的 /openai/v1 地址、API Key 与 deployment name。资源地址不能共用。',
    searchTerms: ['企业', '微软', 'azure', 'deployment', 'foundry']
  }),
  preset({
    key: 'ollama', label: 'Ollama · 本机', vendor: 'Ollama',
    baseUrl: 'http://localhost:11434/v1', engine: 'openai', openaiProtocol: 'chat',
    auth: 'none', category: 'local', region: 'local', billing: 'local',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    hint: '无需 API Key。先在本机启动 Ollama 并安装模型，再获取已安装模型。',
    searchTerms: ['本地', '本机', 'local', 'offline']
  }),
  preset({
    key: 'lmstudio', label: 'LM Studio · 本机', vendor: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1', engine: 'openai', openaiProtocol: 'chat',
    auth: 'none', category: 'local', region: 'local', billing: 'local',
    docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    hint: '无需 API Key。先开启 LM Studio 的本地服务并加载模型；若已启用服务鉴权，可改用 API Key。',
    searchTerms: ['本地', '本机', 'lm studio', 'offline']
  }),
  preset({
    key: 'local-openai', label: '本地 / 自部署 OpenAI 兼容服务', vendor: 'Local',
    baseUrl: 'http://localhost:8000/v1', engine: 'openai', openaiProtocol: 'chat',
    auth: 'none', category: 'local', region: 'local', billing: 'local', requiresBaseUrl: true,
    hint: '填写 vLLM 等本机服务地址后获取模型。无密钥方式仅允许本机回环地址。',
    searchTerms: ['vllm', 'llama.cpp', '本地', '自部署', 'local']
  }),
  preset({
    key: 'oneapi', label: 'New API / One API 网关', vendor: 'New API',
    baseUrl: '', baseUrlPlaceholder: 'https://your-gateway.example.com/v1',
    engine: 'openai', openaiProtocol: 'chat', category: 'gateway', requiresBaseUrl: true,
    docsUrl: 'https://docs.newapi.pro/',
    hint: '填写网关地址和访问令牌，自动获取网关可见模型。已预选通用 Chat 协议。',
    searchTerms: ['oneapi', 'one-api', 'newapi', 'new-api', '中转', '网关']
  }),
  preset({
    key: 'litellm', label: 'LiteLLM 网关', vendor: 'LiteLLM',
    baseUrl: 'http://localhost:4000/v1', engine: 'openai', openaiProtocol: 'chat', category: 'gateway', requiresBaseUrl: true,
    docsUrl: 'https://docs.litellm.ai/docs/proxy/user_keys',
    hint: '填写 LiteLLM 网关地址和虚拟 Key，自动获取允许访问的模型。',
    searchTerms: ['proxy', '网关', 'litellm']
  }),
  preset({
    key: 'custom', label: '自定义服务', vendor: 'Custom', baseUrl: '',
    baseUrlPlaceholder: 'https://your-provider.example.com/v1',
    engine: 'openai', openaiProtocol: 'chat', category: 'gateway', requiresBaseUrl: true,
    hint: '填写服务地址与凭据，按服务文档选择协议；支持 OpenAI、Anthropic 和 Gemini。',
    searchTerms: ['自定义', 'custom', '第三方']
  })
]

/** Preset matching never rewrites saved providers; it supplies help links and form defaults only. */
export function findProviderPresetForConnection(connection: {
  baseUrl?: string
  engine?: EngineKind
  openaiProtocol?: OpenAIProtocol
}): ProviderPreset | undefined {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase()
  const baseUrl = normalize(connection.baseUrl ?? '')
  if (!baseUrl) return undefined
  return PROVIDER_PRESETS.find((item) => item.baseUrl && normalize(item.baseUrl) === baseUrl
    && (!connection.engine || item.engine === connection.engine)
    && (!connection.openaiProtocol || item.engine !== 'openai' || item.openaiProtocol === connection.openaiProtocol))
}
