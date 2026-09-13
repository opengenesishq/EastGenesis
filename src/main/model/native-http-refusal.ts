import type { NativeHttpRefusalEvidence } from '../../shared/native-http-refusal-types'

const refusalEvidence = new WeakMap<Error, NativeHttpRefusalEvidence>()

/** Construct only at a real non-success Response boundary, before output parsing. */
export class NativeProviderHttpError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    if (status === 401 || status === 403 || status === 429) refusalEvidence.set(this, Object.freeze({
      kind: 'http_refusal_before_output', status, outcome: status === 429 ? 'rate_limited' : 'auth_failed'
    }))
  }
}

/** Message text, public status properties and prototype lookalikes are insufficient. */
export function nativeHttpRefusalEvidence(error: unknown): NativeHttpRefusalEvidence | undefined {
  const evidence = error instanceof Error ? refusalEvidence.get(error) : undefined
  return evidence && { ...evidence }
}

/** Preserve the existing OpenAI error formatter and protocol-fallback behavior.
 * Successful/streaming responses and their later errors never gain this evidence. */
export async function consumeWithNativeHttpRefusal<T>(response: Response, consume: (response: Response) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  try { return await consume(response) }
  catch (error) {
    if (response.ok || ![401, 403, 429].includes(response.status) || signal?.aborted
      || (error instanceof Error && error.name === 'AbortError')) throw error
    throw new NativeProviderHttpError(response.status, error instanceof Error ? error.message : String(error), { cause: error })
  }
}
