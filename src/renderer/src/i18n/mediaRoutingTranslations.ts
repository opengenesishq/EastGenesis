export const MEDIA_ROUTING_TRANSLATIONS = {
  mediaRoutingUnavailable: { zh: '指定媒体目标当前不可用', en: 'Selected media target is unavailable' },
  "mediaModelSettings": {
    "zh": "媒体能力与价格",
    "en": "Media capabilities and pricing"
  },
  "mediaModelSettingsHint": {
    "zh": "勾选厂商已声明兼容的能力后，视频工作台会自动复用此连接。仅看到模型名称不能确认协议；这些声明尚不等于实测通过。",
    "en": "Select capabilities explicitly supported by this endpoint to reuse the connection in Video. A model name alone does not confirm its protocol; declarations are not live verification."
  },
  "mediaProtocol_openai-image": {
    "zh": "OpenAI 兼容图片协议",
    "en": "OpenAI-compatible image protocol"
  },
  "mediaProtocol_openai-video": {
    "zh": "OpenAI 兼容视频协议",
    "en": "OpenAI-compatible video protocol"
  },
  "mediaProtocol_openai-speech": {
    "zh": "OpenAI 兼容语音协议",
    "en": "OpenAI-compatible speech protocol"
  },
  "mediaOperation_image.generate": {
    "zh": "文本生图",
    "en": "Generate image"
  },
  "mediaOperation_image.edit": {
    "zh": "图片编辑",
    "en": "Edit image"
  },
  "mediaOperation_video.text-to-video": {
    "zh": "文生视频",
    "en": "Text to video"
  },
  "mediaOperation_video.image-to-video": {
    "zh": "图生视频",
    "en": "Image to video"
  },
  "mediaOperation_video.reference-to-video": {
    "zh": "参考图视频",
    "en": "Reference to video"
  },
  "mediaOperation_speech.synthesize": {
    "zh": "文本转语音",
    "en": "Text to speech"
  },
  "mediaOperation_speech.voice-clone": {
    "zh": "声音克隆",
    "en": "Voice cloning"
  },
  "mediaPriceAmount": {
    "zh": "媒体单价 USD",
    "en": "Media unit price USD"
  },
  "mediaPriceUnit": {
    "zh": "计费单位",
    "en": "Billing unit"
  },
  "mediaPriceUnit_request": {
    "zh": "每次请求",
    "en": "Per request"
  },
  "mediaPriceUnit_second": {
    "zh": "每秒输出",
    "en": "Per output second"
  },
  "mediaPriceUnit_million-characters": {
    "zh": "每百万输入字符",
    "en": "Per million input characters"
  },
  "mediaPriceUnknown": {
    "zh": "价格未知",
    "en": "Price unknown"
  },
  "mediaPriceDeclaredHint": {
    "zh": "估算按此媒体单价计算，不使用文本 token 价格。分辨率或质量差异请填对应规格单价；实际费用以账单为准。",
    "en": "Estimates use this media rate, not text token prices. Enter the rate for the intended resolution and quality; receipts determine actual charges."
  },
  "mediaPriceUnknownHint": {
    "zh": "留空表示未知，自动选择不把它视为免费；有限预算会阻止无法估价的提交。",
    "en": "Blank means unknown, not free. A finite budget blocks submissions without an estimate."
  },
  "mediaRoutingOperation": {
    "zh": "生成能力",
    "en": "Generation capability"
  },
  "mediaRoutingOperationAria": {
    "zh": "媒体生成能力",
    "en": "Media generation capability"
  },
  "mediaRoutingConnection": {
    "zh": "模型连接",
    "en": "Model connection"
  },
  "mediaRoutingProviderAria": {
    "zh": "媒体 Provider",
    "en": "Media provider"
  },
  "mediaRoutingAuto": {
    "zh": "自动选择已配置的媒体模型",
    "en": "Automatically select a configured media model"
  },
  "mediaRoutingCatalogSuffix": {
    "zh": " · 来自模型设置",
    "en": " · From model settings"
  },
  "mediaRoutingPreference": {
    "zh": "路由偏好",
    "en": "Routing preference"
  },
  "mediaRoutingPreferenceAria": {
    "zh": "媒体路由偏好",
    "en": "Media routing preference"
  },
  "mediaRoutingBalanced": {
    "zh": "均衡",
    "en": "Balanced"
  },
  "mediaRoutingCost": {
    "zh": "已知成本优先",
    "en": "Known cost first"
  },
  "mediaRoutingSpeed": {
    "zh": "连接速度优先",
    "en": "Connection speed first"
  },
  "mediaRoutingQuality": {
    "zh": "稳定交付优先",
    "en": "Reliable delivery first"
  },
  "mediaRoutingLocal": {
    "zh": "本地模拟，不外发数据",
    "en": "Local simulation; no data leaves this device"
  },
  "mediaRoutingReuse": {
    "zh": "复用全局模型连接",
    "en": "Reuses global model connection"
  },
  "mediaRoutingManual": {
    "zh": "手动适配",
    "en": "Manual adapter"
  },
  "mediaRoutingAutoHint": {
    "zh": "按声明能力、连接健康和价格选择；未定价不视为免费",
    "en": "Uses declared capabilities, connection health and prices; unknown is not free"
  },
  "mediaRoutingDelete": {
    "zh": "删除媒体 Provider",
    "en": "Delete media provider"
  },
  "mediaRoutingHint": {
    "zh": "媒体能力来自全局模型设置。素材任务只在已获素材外发授权的目标内自动选择；选择具体目标可管理授权。生成后固定原连接，未知结果先对账。",
    "en": "Capabilities come from global model settings. Asset requests route only to targets authorized for those assets; select a target to manage authorization. Submitted jobs retain their connection and reconcile uncertain results."
  },
  "mediaAdapterTitle": {
    "zh": "自定义协议适配（高级）",
    "en": "Custom protocol adapter (advanced)"
  },
  "mediaAdapterName": {
    "zh": "显示名称",
    "en": "Display name"
  },
  "mediaAdapterNameAria": {
    "zh": "媒体 Provider 显示名称",
    "en": "Media provider display name"
  },
  "mediaAdapterBinding": {
    "zh": "绑定 EastGenesis Provider",
    "en": "Bind EastGenesis provider"
  },
  "mediaAdapterChooseProvider": {
    "zh": "选择已配置 Provider",
    "en": "Select a configured provider"
  },
  "mediaAdapterModel": {
    "zh": "媒体模型 ID",
    "en": "Media model ID"
  },
  "mediaAdapterEstimate": {
    "zh": "每任务估价 USD（留空为未知）",
    "en": "Estimate USD per task (blank means unknown)"
  },
  "mediaAdapterEstimateAria": {
    "zh": "媒体任务估价美元",
    "en": "Media task estimate USD"
  },
  "mediaAdapterProtocol": {
    "zh": "媒体协议",
    "en": "Media protocol"
  },
  "mediaAdapterGeneric": {
    "zh": "通用异步媒体",
    "en": "Generic asynchronous media"
  },
  "mediaAdapterAdd": {
    "zh": "添加适配",
    "en": "Add adapter"
  },
  "mediaPricePerRequest": {
    "zh": "每次约 ${amount}",
    "en": "About ${amount} per request"
  }
}
