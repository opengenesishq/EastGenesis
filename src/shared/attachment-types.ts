export interface UserMessageAttachmentView {
  id: string
  /** Content address for durable restart recovery. Older entries may use the content digest as id; readers must verify the actual bytes. */
  hash?: string
  mime: string
  bytes: number
}

/** Shared projection for both native engines and optimistic message rendering. */
export function projectUserMessageImageAttachments(images: ReadonlyArray<{ id: string; hash: string; mime: string; bytes: number }> | undefined): UserMessageAttachmentView[] | undefined {
  return images?.map(({ id, hash, mime, bytes }) => ({ id, hash, mime, bytes }))
}

/** Only legacy content-addressed IDs can supply a missing hash; this never authorizes a file read. */
export function imageAttachmentReferenceHash(reference: UserMessageAttachmentView): string | undefined {
  const digest = /^[a-f0-9]{64}$/
  if (reference.hash !== undefined) {
    if (!digest.test(reference.hash)) return undefined
    if (digest.test(reference.id) && reference.id !== reference.hash) return undefined
    return reference.hash
  }
  return digest.test(reference.id) ? reference.id : undefined
}
