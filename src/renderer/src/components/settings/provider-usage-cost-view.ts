import type { ProviderUsageAggregate } from '../../../../shared/provider-usage-types'
import { formatCost } from '../../format'

type UsageCost = Pick<ProviderUsageAggregate, 'requests' | 'costUsd' | 'pricedRequests' | 'unpricedRequests' | 'costSources'>

/** Unknown charges stay unknown even when the additive partial total is zero. */
export function usageCostAmount(usage: UsageCost, language: 'zh' | 'en'): string {
  if (usage.requests > 0 && usage.pricedRequests === 0) return language === 'zh' ? '未知' : 'Unknown'
  return formatUsageCost(usage.costUsd)
}

export function usageCostDetail(usage: UsageCost, language: 'zh' | 'en'): string {
  const zh = language === 'zh'
  const sources = usage.costSources ?? []
  const reported = sources.find((source) => source.source === 'reported')
  const imported = sources.find((source) => source.source === 'imported')
  const estimated = sources.filter((source) => source.source === 'provider-pricing' || source.source === 'builtin-pricing')
  return [
    reported ? `${zh ? '上报' : 'Reported'} ${formatUsageCost(reported.costUsd)}` : '',
    estimated.length ? `${zh ? '估算' : 'Estimated'} ${formatUsageCost(estimated.reduce((sum, source) => sum + source.costUsd, 0))}` : '',
    imported ? `${zh ? '历史导入' : 'Imported'} ${formatUsageCost(imported.costUsd)}` : '',
    usage.unpricedRequests > 0 ? (zh ? `${usage.unpricedRequests} 次费用未知，未计入` : `${usage.unpricedRequests} unknown charges excluded`) : ''
  ].filter(Boolean).join(' · ')
}

export function formatUsageCost(value: number): string {
  if (value > 0 && value < 0.000001) return '<$0.000001'
  return value > 0 && value < 0.0001 ? `$${value.toFixed(6)}` : formatCost(value)
}
