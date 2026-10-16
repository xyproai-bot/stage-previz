// 線上使用說明（/help）的段落位置：分享頁、檢查清單卡片、設定頁、工作站、各個「?」都從這裡拿連結。
// 段落 id 不要隨便改（別的頁面、傳出去的連結會直接跳到這些位置）。只能加新的。

import type { NdiStep } from './ndiSteps';

export const HELP_PATH = '/help';

export const HELP_ANCHORS = {
  // ─── 開始使用 ───
  start: 'start',
  roles: 'roles',
  loginInvite: 'login-invite',
  loginCode: 'login-code',
  landing: 'landing',
  notifications: 'notifications',

  // ─── 製作 ───
  producer: 'producer',
  prodProject: 'prod-project',
  prodModel: 'prod-model',
  prodNaming: 'prod-naming',
  prodCalibrate: 'prod-calibrate',
  prodScaleProps: 'prod-scale-props',
  prodSongs: 'prod-songs',
  prodDrive: 'prod-drive',
  prodVideos: 'prod-videos',
  prodAssign: 'prod-assign',
  prodCues: 'prod-cues',
  prodCueTiming: 'prod-cue-timing',
  prodTemplates: 'prod-templates',
  prodUndo: 'prod-undo',
  prodMechanisms: 'prod-mechanisms',
  prodMechSetup: 'prod-mech-setup',
  prodMechCue: 'prod-mech-cue',
  prodMechTiming: 'prod-mech-timing',
  prodMechSplit: 'prod-mech-split',
  prodMechGroup: 'prod-mech-group',
  prodMechHoist: 'prod-mech-hoist',
  prodMechSheet: 'prod-mech-sheet',
  prodMechConvert: 'prod-mech-convert',
  prodLedCanvas: 'prod-led-canvas',
  prodLedTemplate: 'prod-led-template',
  prodView: 'prod-view',
  prodShare: 'prod-share',
  prodInvite: 'prod-invite',
  prodViewAs: 'prod-view-as',
  prodLoginCodes: 'prod-login-codes',
  prodSystem: 'prod-system',
  prodArchive: 'prod-archive',

  // ─── 動畫師 ───
  animator: 'animator',
  animStudio: 'anim-studio',
  animSource: 'anim-source',
  animAddVideo: 'anim-add-video',
  animAeExport: 'anim-ae-export',
  animVersions: 'anim-versions',
  animSubmit: 'anim-submit',
  animFeedback: 'anim-feedback',
  animCompare: 'anim-compare',
  animLedMap: 'anim-led-map',
  animAeScript: 'anim-ae-script',
  animTestPattern: 'anim-test-pattern',

  // ─── AE 即時預覽（動畫師；這一章的 id 很多頁面直接連，不能改）───
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
  aeNoE3d: 'ae-no-e3d',
  aeSpeedTips: 'ae-speed-tips',
  aeLiveColor: 'ae-live-color',
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

  // ─── 導演 ───
  director: 'director',
  dirBoard: 'dir-board',
  dirPlay: 'dir-play',
  dirAddLink: 'dir-add-link',
  dirComment: 'dir-comment',
  dirAttach: 'dir-attach',
  dirDecide: 'dir-decide',
  dirHistory: 'dir-history',
  dirCompare: 'dir-compare',
  dirAnnotate: 'dir-annotate',
  dirOpen: 'dir-open',
  dirPlayer: 'dir-player',
  dirExport: 'dir-export',

  // ─── 客戶（分享連結）───
  client: 'client',
  clientOpen: 'client-open',
  clientCamera: 'client-camera',
  clientPlay: 'client-play',
  clientLocal: 'client-local',
  clientMobile: 'client-mobile',
  clientComment: 'client-comment',

  // ─── 常見問題 ───
  questions: 'questions',
  qPermission: 'q-permission',
  qVideo: 'q-video',
  qUpload: 'q-upload',
  qChina: 'q-china',
  qBrowsers: 'q-browsers',
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
