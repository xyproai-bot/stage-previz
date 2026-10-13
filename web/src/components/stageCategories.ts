// 舞台物件分類：名稱 + 圖示（上傳模型、物件清單共用同一套）
import { Cog, Crosshair, Lightbulb, Monitor, PersonStanding, Shapes, type LucideIcon } from 'lucide-react';
import type { StageObjectCategory } from '../lib/api';

export const STAGE_CATEGORY: Record<StageObjectCategory, { label: string; icon: LucideIcon }> = {
  led_panel:  { label: 'LED 面板', icon: Monitor },
  mechanism:  { label: '機關', icon: Cog },
  walk_point: { label: '走位點', icon: Crosshair },
  fixture:    { label: '燈光/道具', icon: Lightbulb },
  performer:  { label: '表演者', icon: PersonStanding },
  other:      { label: '其他', icon: Shapes },
};

/** 選單裡的順序 */
export const STAGE_CATEGORY_ORDER: StageObjectCategory[] = ['led_panel', 'mechanism', 'walk_point', 'fixture', 'performer', 'other'];
