const geometryBytes = new Map<string, number>()
let users = 0
export function recordPalaceGeometryBytes(asset: string, bytes: number): void { geometryBytes.set(asset, bytes) }
export function retainPalaceResourceStats(): () => void { users++; return () => { users = Math.max(0, users - 1) } }
export function palaceResourceSnapshot(): { entries: number; bytes: number; retained: number } {
  return { entries: geometryBytes.size, bytes: [...geometryBytes.values()].reduce((sum, bytes) => sum + bytes, 0), retained: users > 0 ? 1 : 0 }
}
