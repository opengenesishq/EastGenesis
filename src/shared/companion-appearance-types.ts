export interface CompanionImageAsset {
  id: string
  name: string
  mime: 'image/png' | 'image/gif'
  width: number
  height: number
  bytes: number
  createdAt: number
}
export interface CompanionAppearanceApi {
  listCompanionImages(): Promise<CompanionImageAsset[]>
  importCompanionImage(): Promise<CompanionImageAsset | null>
  previewCompanionImage(id: string): Promise<{ asset: CompanionImageAsset; dataUrl: string }>
  removeCompanionImage(id: string): Promise<void>
}
