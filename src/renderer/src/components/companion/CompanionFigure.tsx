import { APP_ICON_URL, APP_NAME } from '../../brand'
import './companion-images.css'

/** Use the product mark in the companion surface so the retired palace character
 * cannot reappear as a default brand/avatar. */
export default function CompanionFigure({ image }: { image?: { dataUrl: string; name: string } } = {}): React.JSX.Element {
  void image
  return <img className="companion-brand-image" src={APP_ICON_URL} alt={APP_NAME} draggable={false} />
}
