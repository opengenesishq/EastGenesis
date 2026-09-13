/** A real non-success HTTP response observed before consuming model output.
 * It describes a refusal, not permission to retry or proof of a zero bill. */
export interface NativeHttpRefusalEvidence {
  kind: 'http_refusal_before_output'
  status: 401 | 403 | 429
  outcome: 'auth_failed' | 'rate_limited'
}
