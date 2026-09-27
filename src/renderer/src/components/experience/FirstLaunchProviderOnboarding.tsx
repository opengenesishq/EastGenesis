import { useEffect, useState } from 'react'
import { Check, KeyRound, Sparkles, WandSparkles } from 'lucide-react'
import { useStore } from '../../store'
import ProviderEditor, { type ProviderEditorCloseResult } from '../ProviderEditor'
import { AUTO_MODEL } from '../../../../shared/types'

export const FIRST_LAUNCH_PROVIDER_ONBOARDING_STORAGE_KEY = 'caogen.first-launch-provider-onboarding.v1'

type OnboardingState = 'opened' | 'dismissed' | 'completed'

function readState(): OnboardingState | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(FIRST_LAUNCH_PROVIDER_ONBOARDING_STORAGE_KEY)
    return value === 'opened' || value === 'dismissed' || value === 'completed' ? value : null
  } catch { return null }
}

function writeState(value: OnboardingState): void {
  try { window.localStorage.setItem(FIRST_LAUNCH_PROVIDER_ONBOARDING_STORAGE_KEY, value) } catch { /* storage is optional */ }
}

export default function FirstLaunchProviderOnboarding(): React.JSX.Element | null {
  const providersLoaded = useStore((state) => state.providersLoaded)
  const providers = useStore((state) => state.providers)
  const sessionCount = useStore((state) => state.order.length)
  const [dismissed, setDismissed] = useState(() => {
    const state = readState()
    return state === 'dismissed' || state === 'completed'
  })
  const [configuring, setConfiguring] = useState(false)
  const ready = providers.some((provider) => provider.ready && provider.models.length > 0)

  useEffect(() => {
    if (ready && !configuring && readState() !== 'completed') writeState('completed')
  }, [ready, configuring])

  // Existing installations should keep their current entry point. This gate
  // only appears on a genuinely empty first run, before a task is created.
  if (!providersLoaded || (ready && !configuring) || sessionCount > 0 || dismissed) return null

  const connect = (): void => {
    writeState('opened')
    setConfiguring(true)
  }
  const skip = (): void => {
    writeState('dismissed')
    setDismissed(true)
  }

  const closeSetup = (result: ProviderEditorCloseResult): void => {
    if (result.reason === 'cancelled') {
      setConfiguring(false)
      return
    }
    if (!result.provider.ready || !result.provider.models.length) return
    const state = useStore.getState()
    state.updateWelcomeDraft({
      computeSelectionSource: 'user',
      providerId: result.provider.id,
      model: state.welcomeDraft.routingMode === 'fixed' ? result.provider.models[0] : AUTO_MODEL
    })
    writeState('completed')
    setConfiguring(false)
    setDismissed(true)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.welcome-composer-input')?.focus())
  }

  if (configuring) {
    return (
      <div className="first-launch-onboarding" role="dialog" aria-modal="true" aria-label="配置 EastGenesis 模型">
        <section className="first-launch-onboarding-card first-launch-onboarding-setup">
          <ProviderEditor provider={null} onClose={closeSetup} />
        </section>
      </div>
    )
  }

  return (
    <div className="first-launch-onboarding" role="dialog" aria-modal="true" aria-labelledby="first-launch-onboarding-title">
      <section className="first-launch-onboarding-card">
        <div className="first-launch-onboarding-kicker"><Sparkles size={15} aria-hidden="true" /> EastGenesis</div>
        <h2 id="first-launch-onboarding-title">先连接一个模型，再开始工作</h2>
        <p className="first-launch-onboarding-lede">只需要配置一次。之后直接输入一句话，EastGenesis 会执行并返回结果。</p>
        <ol className="first-launch-onboarding-steps">
          <li><span><KeyRound size={15} aria-hidden="true" /></span><div><strong>连接模型</strong><small>选择厂商，填写凭据或导入本机配置。</small></div></li>
          <li><span><WandSparkles size={15} aria-hidden="true" /></span><div><strong>写下你的要求</strong><small>用自然语言描述想完成的事情，按 Enter 直接开始。</small></div></li>
          <li><span><Check size={15} aria-hidden="true" /></span><div><strong>查看结果</strong><small>任务完成后，结果和后续操作会回到当前对话。</small></div></li>
        </ol>
        <div className="first-launch-onboarding-actions">
          <button type="button" className="btn btn-primary" onClick={connect}>现在配置模型</button>
          <button type="button" className="btn btn-ghost" onClick={skip}>先进入工作台</button>
        </div>
        <p className="first-launch-onboarding-footnote">稍后也可以在首屏的“连接模型”按钮中继续配置。</p>
      </section>
    </div>
  )
}
