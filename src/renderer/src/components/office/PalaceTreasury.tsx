import { useEffect, useRef } from 'react'
import { useStore } from '../../store'
import UsageAndCosts from '../settings/UsageAndCosts'
import './palace-work-panel.css'

export default function PalaceTreasury({ onClose }: { onClose(): void }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const providers = useStore(state => state.providers)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <section ref={panel} tabIndex={-1} className="palace-work-panel palace-treasury no-drag" data-palace-treasury role="dialog"
    aria-label={zh ? '国库 · 户部' : 'Treasury · Ministry of Revenue'} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }}>
    <header><h2>{zh ? '国库 · 户部' : 'Treasury · Ministry of Revenue'}</h2><div>
      <button type="button" className="btn btn-ghost btn-sm" data-treasury-open-settings onClick={() => {
        onClose()
        useStore.getState().setShowSettings(true, 'usage')
      }}>{zh ? '在设置中查看' : 'Open in settings'}</button>
      <button type="button" className="btn btn-primary btn-sm" data-treasury-close onClick={onClose}>{zh ? '回到故宫' : 'Back to palace'}</button>
    </div></header>
        <p className="palace-work-freshness">{zh ? '户部掌钱粮财赋。这里查看 EastGenesis 的厂商、模型用量与费用，与现代工作台共用账目。' : 'The Ministry of Revenue manages public finance. These provider and model usage records are shared with the modern workspace.'}</p>
    <UsageAndCosts providers={providers} />
  </section>
}
