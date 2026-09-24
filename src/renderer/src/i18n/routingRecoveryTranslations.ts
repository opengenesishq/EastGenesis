export const ROUTING_RECOVERY_TRANSLATIONS = {
  failoverTitle: { zh: '厂商故障自动切换', en: 'Automatic provider failover' },
  failoverText: {
    zh: '{from} 故障({reason}),已切换 → {to},自动重试中',
    en: '{from} failed ({reason}), switched → {to}, retrying automatically'
  },
  keyFailoverTitle: { zh: 'Provider 密钥自动切换', en: 'Automatic provider key failover' },
  keyFailoverText: {
    zh: '{provider} 密钥 {from} 失败({reason}),已切换 → {to},自动重试中',
    en: '{provider} key {from} failed ({reason}), switched → {to}, retrying automatically'
  },
  modelFailoverTitle: { zh: 'Provider 模型自动切换', en: 'Automatic provider model failover' },
  modelFailoverText: {
    zh: '{provider} 的模型 {from} 不可用（{reason}），已切换到 {to} 并自动重试',
    en: '{provider} model {from} failed ({reason}); switched to {to} and retrying automatically'
  },
  protocolFailoverTitle: { zh: 'Provider 协议自动降级', en: 'Automatic provider protocol fallback' },
  protocolFailoverText: {
    zh: '{provider} / {model} 的 Responses 协议不可用（{reason}），已降级到 Chat Completions 并自动重试',
    en: '{provider} / {model} cannot use Responses ({reason}); fell back to Chat Completions and is retrying'
  },
  assistantProtocolFailoverStatus: {
    zh: '当前接口不支持 Responses，已自动改用 Chat Completions 重试。',
    en: 'Responses is unavailable, so EastGenesis is retrying with Chat Completions.'
  },
  recoveryExhaustedTitle: { zh: 'Provider 自动恢复已耗尽', en: 'Provider recovery exhausted' },
  recoveryExhaustedText: {
    zh: '{provider} / {model} 自动恢复失败（{reason}），请检查授权、余额、模型或端点配置。',
    en: 'Automatic recovery failed for {provider} / {model} ({reason}). Check authorization, balance, model, or endpoint settings.'
  },
  openProviderSettings: { zh: '打开 Provider 设置', en: 'Open Provider settings' }
} as const
