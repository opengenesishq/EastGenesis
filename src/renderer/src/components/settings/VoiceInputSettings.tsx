import type { ProviderView } from '../../../../shared/types'
import type { VoiceInputSettings as VoiceSettings } from '../../../../shared/voice-input-types'
import { PreferenceRow } from './DesktopPreferences'
import LocalSpeechSettings from './LocalSpeechSettings'

export default function VoiceInputSettings({ value, providers, zh, onChange, onAddProvider }: {
  value?: VoiceSettings; providers: ProviderView[]; zh: boolean;
  onChange(value: VoiceSettings): void; onAddProvider(): void
}): React.JSX.Element {
  const config = value ?? { providerId: '', model: '', language: '' }
  const compatible = providers.filter(provider => provider.engine === 'openai')
  const selected = providers.find(provider => provider.id === config.providerId)
  const suggestedModels = selected?.models.filter(model => /whisper|transcrib|speech-to-text|\basr\b/i.test(model)) ?? []
  return <>
    <p className="desktop-preference-intro">{zh ? '听写可预览、修改文字后插入草稿。当前任务的持续语音会话会自动提交每句话，并用本地系统声音播报回答；两种入口共用下方转写连接。' : 'Dictation lets you edit text before inserting it into a draft. Voice conversations submit each phrase to the current task and read replies with a local system voice. Both use the transcription connection below.'}</p>
    <div className="desktop-preference-card" data-voice-settings>
      <PreferenceRow title={zh ? '转写厂商' : 'Transcription provider'} description={zh ? '复用已保存连接的密钥。' : 'Use a saved connection and its credentials.'}>
        <select className="select" aria-label={zh ? '转写厂商' : 'Transcription provider'} value={config.providerId} onChange={event => onChange({ ...config, providerId: event.target.value, model: '' })}>
          <option value="">{zh ? '选择厂商' : 'Choose a provider'}</option>
          {config.providerId && !compatible.some(provider => provider.id === config.providerId) && <option value={config.providerId}>{selected?.name ?? (zh ? '原连接不可用' : 'Connection unavailable')}</option>}
          {compatible.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </PreferenceRow>
      <PreferenceRow title={zh ? '语音转写模型' : 'Transcription model'} description={zh ? '填写该厂商支持的语音转文字模型名称。' : 'Enter a speech-to-text model supported by this provider.'}>
        <input className="input" list="voice-transcription-models" aria-label={zh ? '语音转写模型' : 'Transcription model'} value={config.model} maxLength={200} placeholder={zh ? '选择或输入模型' : 'Choose or enter a model'} onChange={event => onChange({ ...config, model: event.target.value })} />
        <datalist id="voice-transcription-models">{suggestedModels.map(model => <option key={model} value={model} />)}</datalist>
      </PreferenceRow>
      <PreferenceRow title={zh ? '识别语言' : 'Language'}>
        <select className="select" aria-label={zh ? '识别语言' : 'Language'} value={config.language ?? ''} onChange={event => onChange({ ...config, language: event.target.value || undefined })}>
          <option value="">{zh ? '自动识别' : 'Detect automatically'}</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option>
          {config.language && !['zh', 'en', 'ja', 'ko'].includes(config.language) && <option value={config.language}>{config.language}</option>}
        </select>
      </PreferenceRow>
    </div>
    <p className="settings-hint">{zh ? '目前支持提供音频转写接口的 OpenAI 兼容连接；具体支持以厂商为准。听写点击“转成文字”后上传；持续语音明确开启后按句自动上传，结束或切任务即停止。播报时暂停收音，可打断继续说；这属于分段转写与系统播报，不是厂商原生全双工。调用会计入用量，未返回费用时显示未计价。' : 'Use an OpenAI-compatible audio transcription endpoint. Dictation uploads on confirmation; an explicitly started voice conversation uploads phrases automatically until ended or you switch tasks. Listening pauses during speech; interrupt to resume. This is segmented ASR with system speech, not provider-native full duplex. Usage is recorded; missing costs remain unpriced.'}</p>
    {!compatible.length && <button type="button" className="btn btn-ghost" onClick={onAddProvider}>{zh ? '添加厂商' : 'Add provider'}</button>}
    <LocalSpeechSettings value={value} zh={zh} onChange={onChange} />
  </>
}
