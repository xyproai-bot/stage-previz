// 暫時用的 mock data，Phase 1 後半接上 D1 backend 後移除

export type ProjectStatus = 'active' | 'in_review' | 'archived';
export type SongStatus = 'todo' | 'in_review' | 'approved' | 'needs_changes';

export interface SongStatusCounts {
  todo: number;
  in_review: number;
  approved: number;
  needs_changes: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  thumbnailUrl?: string;
  status: ProjectStatus;
  showId?: string | null;               // 屬於哪個 Show（巡迴），可為 null
  songCount: number;
  songStatusCounts?: SongStatusCounts;  // worker 已支援；mock 可省略，前端 fallback 全 todo
  cueCount: number;
  proposalCount: number;
  updatedAt: string; // ISO
  members: { id: string; name: string; avatarColor: string }[];
}

const palette = ['#10c78a', '#ffaa44', '#5294ff', '#c264ff', '#ff5470', '#ffd84a'];

function avatar(name: string, idx: number) {
  return { id: `u_${idx}`, name, avatarColor: palette[idx % palette.length] };
}

export const MOCK_PROJECTS: Project[] = [
  {
    id: 'p1',
    name: '魅影 2026',
    description: '年度大型音樂劇 LED 舞臺預覽，含 12 首歌的 cue',
    status: 'active',
    songCount: 12,
    cueCount: 47,
    proposalCount: 3,
    updatedAt: '2026-04-29T05:30:00Z',
    members: [
      avatar('Phang', 0),
      avatar('Chen', 1),
      avatar('Lin', 2),
      avatar('Wang', 3),
      avatar('Liu', 4),
      avatar('Tsai', 5),
    ],
  },
  {
    id: 'p2',
    name: '演唱會 X',
    description: '巡迴第二場，待修中',
    status: 'in_review',
    songCount: 8,
    cueCount: 24,
    proposalCount: 1,
    updatedAt: '2026-04-28T18:00:00Z',
    members: [avatar('Phang', 0), avatar('Hsu', 2), avatar('Wu', 3)],
  },
  {
    id: 'p3',
    name: 'Virtual Reality Tour',
    description: '虛擬演出體驗',
    status: 'active',
    songCount: 8,
    cueCount: 24,
    proposalCount: 1,
    updatedAt: '2026-04-29T02:00:00Z',
    members: [avatar('Yang', 1), avatar('Ko', 2), avatar('Chiu', 4)],
  },
  {
    id: 'p4',
    name: 'Product Configurator',
    description: '產品配置展示',
    status: 'active',
    songCount: 1,
    cueCount: 71,
    proposalCount: 1,
    updatedAt: '2026-04-29T01:30:00Z',
    members: [avatar('Phang', 0), avatar('Lee', 1), avatar('Kuo', 5)],
  },
];
