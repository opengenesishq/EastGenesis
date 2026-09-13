/** Text-provider base URLs commonly already include /v1; reuse that API root. */
export function mediaEndpointUrl(baseUrl: string, operationPath: string): string {
  const base = new URL(baseUrl)
  if (!operationPath.startsWith('/') || operationPath.startsWith('//') || /[?#]/.test(operationPath)) {
    throw new Error('Media operation path is invalid')
  }
  const root = base.pathname.replace(/\/+$/, '')
  const suffix = root.endsWith('/v1') && operationPath.startsWith('/v1/') ? operationPath.slice(3) : operationPath
  base.pathname = `${root}${suffix}`
  return base.toString()
}
