export type OfficeOperationDomain = 'media' | 'projects' | 'workItems'
export type OfficeOperationStatus = { state: 'loading' | 'ready' | 'stale'; error?: string }

/** Independent canonical reads can publish immediately; stale replies never replace newer actions. */
export function createOfficeOperationRefresh(onStatus: (domain: OfficeOperationDomain, status: OfficeOperationStatus) => void) {
  let disposed = false
  const versions: Record<OfficeOperationDomain, number> = { media: 0, projects: 0, workItems: 0 }
  const invalidate = (domain: OfficeOperationDomain): void => { versions[domain]++ }
  const read = async <T>(domain: OfficeOperationDomain, load: () => Promise<T>, publish: (value: T) => void): Promise<void> => {
    if (disposed) return
    const version = ++versions[domain]
    try {
      const result = await load()
      if (disposed || version !== versions[domain]) return
      publish(result)
      onStatus(domain, { state: 'ready' })
    } catch (cause) {
      if (disposed || version !== versions[domain]) return
      onStatus(domain, { state: 'stale', error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return { read, invalidate, dispose: (): void => { disposed = true } }
}
