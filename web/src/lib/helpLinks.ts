// 線上使用說明（/help）的段落位置：分享頁、檢查清單卡片、設定頁、工作站都從這裡拿連結。
// 段落 id 不要隨便改（別的頁面、傳出去的連結會直接跳到這些位置）。

import type { NdiStep } from './ndiSteps';

export const HELP_PATH = '/help';

/** 「AE 即時預覽」這一章的段落 */
export const HELP_ANCHORS = {
  aeLive: 'ae-live',
  whatYouNeed: 'what-you-need',
  setup: 'setup',
  installNdiTools: 'install-ndi-tools',
  installHelper: 'install-helper',
  installHelperWindows: 'install-helper-windows',
  installHelperMac: 'install-helper-mac',
  aeNdiOutput: 'ae-ndi-output',
  chromeAllow: 'chrome-allow',
  use: 'use',
  resolution: 'resolution',
  chooseSource: 'choose-source',
  faq: 'faq',
  faqWaitingFrames: 'faq-waiting-frames',
  faqBlack: 'faq-black',
  faqNoAe: 'faq-no-ae',
  faqSafari: 'faq-safari',
  faqBlocked: 'faq-blocked',
  faqNoHelper: 'faq-no-helper',
  faqOutdated: 'faq-outdated',
  faqNoNdiTools: 'faq-no-ndi-tools',
  faqAutostart: 'faq-autostart',
} as const;

export type HelpAnchor = (typeof HELP_ANCHORS)[keyof typeof HELP_ANCHORS];

/** 說明頁網址（相對路徑：正式站、測試站、本機都通） */
export function helpUrl(anchor?: HelpAnchor | null): string {
  return anchor ? `${HELP_PATH}#${anchor}` : HELP_PATH;
}

/**
 * 檢查清單卡在哪一步 → 說明頁哪一段（標題跟卡片上的字一樣）。
 * 連線中 / 已經 LIVE / 設定頁檢查 OK → null（不用看說明）
 */
export function ndiHelpAnchor(step: NdiStep): HelpAnchor | null {
  switch (step) {
    case 'browser_unsupported': return HELP_ANCHORS.faqSafari;
    case 'need_permission': return HELP_ANCHORS.chromeAllow;
    case 'permission_denied': return HELP_ANCHORS.faqBlocked;
    case 'helper_missing': return HELP_ANCHORS.faqNoHelper;
    case 'helper_outdated': return HELP_ANCHORS.faqOutdated;
    case 'ndi_missing': return HELP_ANCHORS.faqNoNdiTools;
    case 'no_source': return HELP_ANCHORS.faqNoAe;
    case 'no_local_source': return HELP_ANCHORS.faqNoAe;
    case 'waiting_frames': return HELP_ANCHORS.faqWaitingFrames;
    case 'connecting':
    case 'live':
    case 'ready':
      return null;
  }
}
