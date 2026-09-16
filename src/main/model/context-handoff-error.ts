/** Local context integrity failures must never trigger Provider retries or health penalties. */
export class ModelContextHandoffError extends Error {
  readonly name = 'ModelContextHandoffError'

  constructor(message: string, cause: unknown) {
    super(message, { cause })
  }
}
