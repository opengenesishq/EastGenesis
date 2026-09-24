import { useStore } from '../../store'
import './welcome-provider-setup.css'

export default function WelcomeProviderSetup(): React.JSX.Element | null {
  const loaded = useStore(state => state.providersLoaded)
  const providers = useStore(state => state.providers)
  const zh = useStore(state => state.settings.language === 'zh')
  const open = useStore(state => state.setShowSettings)
  if (!loaded || providers.some(provider => provider.ready && provider.models.length > 0)) return null
  return <section className="welcome-provider-setup" aria-label={zh ? '连接模型开始工作' : 'Connect a model to get started'} data-welcome-provider-setup>
    <span>{zh ? '连接一个模型即可开始，输入的内容会保留。' : 'Connect a model to start. Your draft will be kept.'}</span>
    <div>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => open(true, 'providers', 'welcome-provider-recovery')}>{zh ? '连接模型' : 'Connect a model'}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(true, 'providers', 'welcome-provider-import')}>{zh ? '从本机导入' : 'Import from this computer'}</button>
    </div>
  </section>
}
