import type { HasLibraryCue } from '../lib/cueBadge';
import { cueNumLabel } from '../lib/cueBadge';
import './CueNumBadge.css';

/** Cue 庫編號小徽章；舊模式專案（沒有編號）什麼都不畫 */
export function CueNumBadge({ cue }: { cue: Pick<HasLibraryCue, 'libraryCue'> }) {
  const label = cueNumLabel(cue);
  if (!label) return null;
  return <span className="cue-num-badge" title={`Cue 庫編號 ${label}`}>{label}</span>;
}
