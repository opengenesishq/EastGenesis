import type { OfficeOperationDomain, OfficeOperationStatus } from './officeOperationRefresh'

export default function OfficeOperationNotice({ statuses, zh }: {
  statuses: Record<OfficeOperationDomain, OfficeOperationStatus>; zh: boolean
}): React.JSX.Element | null {
  const labels = zh ? { media: '媒体', projects: '项目', workItems: '任务' } : { media: 'Media', projects: 'Projects', workItems: 'Tasks' }
  const stale = (Object.keys(statuses) as OfficeOperationDomain[]).filter((key) => statuses[key].state === 'stale')
  if (!stale.length) return null
  return <p role="status" data-office-operation-stale={stale.join(',')}>
    {stale.map((key) => labels[key]).join(' / ')}{zh ? '数据暂未刷新，当前保留最近记录。' : ' could not refresh. Showing the last available records.'}
  </p>
}
