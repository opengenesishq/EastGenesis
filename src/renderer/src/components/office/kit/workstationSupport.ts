export type WorkstationDetail = 'full' | 'compact'

export function resolveWorkstationDetail(
  active: boolean,
  activeDetail: WorkstationDetail | undefined,
  detail: WorkstationDetail | undefined
): WorkstationDetail {
  return active ? activeDetail ?? 'full' : detail ?? 'compact'
}
