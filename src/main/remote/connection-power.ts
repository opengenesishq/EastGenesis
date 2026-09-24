interface ConnectionPowerAdapter {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** Owns only the remote listener's blocker; task blockers keep their own lifetime. */
export class RemoteConnectionPower {
  private id: number | undefined
  constructor(private readonly adapter: ConnectionPowerAdapter) {}
  get active(): boolean { return this.id !== undefined && this.adapter.isStarted(this.id) }
  setActive(active: boolean): void {
    if (!active) {
      if (this.id === undefined) return
      this.adapter.stop(this.id)
      this.id = undefined
    } else if (!this.active) {
      this.id = this.adapter.start('prevent-app-suspension')
    }
  }
}
