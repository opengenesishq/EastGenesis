/** Small injectable queue so stop/task-switch invalidates even late speech callbacks. */
export function createVoiceReplyPlayback(driver: {
  speak(text: string, done: (error?: string) => void): void
  cancel(): void
}, changed: (speaking: boolean, error?: string) => void) {
  const queue: string[] = []
  let generation = 0
  let speaking = false
  const next = (): void => {
    if (speaking || !queue.length) return
    const text = queue.shift()!
    const current = generation
    speaking = true; changed(true)
    const done = (error?: string): void => {
      if (generation !== current) return
      speaking = false
      if (error) queue.length = 0
      changed(false, error)
      if (!error) next()
    }
    try { driver.speak(text, done) } catch (error) { done(error instanceof Error ? error.message : String(error)) }
  }
  return {
    enqueue(text: string): void {
      // Short utterances avoid platform-specific long-utterance truncation.
      const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/[#*`_]/g, '').trim()
      queue.push(...(clean.match(/[\s\S]{1,180}(?:[。！？.!?\n]|$)|[\s\S]{1,180}/g) ?? []))
      next()
    },
    interrupt(): void {
      generation++; queue.length = 0; speaking = false
      driver.cancel(); changed(false)
    },
    get speaking(): boolean { return speaking }
  }
}
