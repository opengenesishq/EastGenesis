import { app } from 'electron'
import { CompanionImageStore } from './companion-images'
let store: CompanionImageStore | undefined
export function companionImages(): CompanionImageStore { return store ??= new CompanionImageStore(app.getPath('userData')) }
