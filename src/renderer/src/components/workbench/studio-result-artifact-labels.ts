import type { StudioResultArtifact } from '../../../../shared/studio-result-types'

export function artifactVerificationStatus(artifact: StudioResultArtifact, language: 'zh' | 'en'): { label: string; tone: 'good' | 'warn' | 'bad' } {
  const statuses = language === 'en' ? {
    ready: { label: 'ready to deliver', tone: 'good' as const },
    verification_pending: { label: 'acceptance pending', tone: 'warn' as const },
    evidence_missing: { label: 'evidence missing', tone: 'bad' as const },
    failed: { label: 'acceptance failed', tone: 'bad' as const },
    unavailable: { label: 'file unavailable', tone: 'bad' as const },
    superseded: { label: 'historical', tone: 'warn' as const }
  } : {
    ready: { label: '可交付', tone: 'good' as const },
    verification_pending: { label: '待验收', tone: 'warn' as const },
    evidence_missing: { label: '缺少证据', tone: 'bad' as const },
    failed: { label: '验收失败', tone: 'bad' as const },
    unavailable: { label: '文件不可用', tone: 'bad' as const },
    superseded: { label: '历史版本', tone: 'warn' as const }
  }
  return statuses[artifact.deliveryStatus]
}

export function artifactCategoryLabel(artifact: StudioResultArtifact, language: 'zh' | 'en'): string {
  const labels = language === 'en'
    ? { office: 'Office', code: 'Code', media: 'Media', report: 'Report', package: 'Package', other: 'Artifact' }
    : { office: 'Office 文档', code: '代码', media: '媒体', report: '报告', package: '交付包', other: '产物' }
  return labels[artifact.deliveryCategory]
}
