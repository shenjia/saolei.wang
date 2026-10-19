// 录像自动分拣阈值常量（2026-10-19 方案 v2）
//
// 独立成模块的原因：AdminReviewList（客户端组件）需要阈值渲染原因标签，
// 而 video-triage.ts 依赖 fs/prisma 只能服务端用——常量拆出来保持零依赖，
// 服务端判档与客户端展示共用同一份，杜绝两处阈值漂移。

/** auto_reason 位码 */
export const AUTO_REASON = {
  PRESS: 1 << 0,
  STNB: 1 << 1,
  CLS: 1 << 2,
  PATH0: 1 << 3,
  CLICK_FLOOR: 1 << 4,
  // bit5 预留（首击信号已废：录像计时从首事件起算恒 0，无区分度）
  PERSON_RECORD: 1 << 6,
  TOP_BOARD: 1 << 7,
  FIRST_ENLIST: 1 << 8,
  LOW_TRUST: 1 << 9,
} as const;

/** press-release 分级阈值（ms）——初级/中级 45（2026-10-19 张老师晚定：中级从 56 放宽），
 *  高级 60；初/中锚定 P0 回测人类 p1 分位 44.3 / 55.9 取整收紧，高级沿用原线 */
export const PRESS_AVG_MS: Record<string, number> = { beg: 45, int: 45, exp: 60 };

/** STNB 分级阈值（各级 p99 取整上浮） */
export const STNB_TRIGGER: Record<string, number> = { beg: 205, int: 160, exp: 150 };
