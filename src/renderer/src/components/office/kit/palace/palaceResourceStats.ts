let geometryBytes = 0
let users = 0
export function recordPalaceGeometryBytes(bytes: number): void { geometryBytes = bytes }
export function retainPalaceResourceStats(): () => void { users++; return () => { users = Math.max(0, users - 1) } }
export function palaceResourceSnapshot(): { entries: number; bytes: number; retained: number } {
  return { entries: geometryBytes > 0 ? 1 : 0, bytes: geometryBytes, retained: users > 0 ? 1 : 0 }
}
