const queues = new Map<string, Promise<unknown>>()
/** Short local state transactions shared by deployment and management. Processes run outside this lock. */
export async function withSiteStateLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const prior = queues.get(root) ?? Promise.resolve(), next = prior.catch(() => undefined).then(action)
  queues.set(root, next)
  try { return await next } finally { if (queues.get(root) === next) queues.delete(root) }
}
