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
  /** path 异常：超大范围往返瞬移（2026-10-23 张老师指令；347022+已屏蔽 3 盘定标，
   *  全站 30 万盘回扫零误报——判定口径见 lib/video-triage.ts pathJumpStats） */
  PATH_JUMP: 1 << 10,
  /** path 超速：全程平均移动速率超生理上限（2026-10-23 定标：≥30s 盘人类全站
   *  max 22.4 格/s（92622 孤例），作弊盘 51.2；30 格/s 线全站唯一命中 347022） */
  PATH_SPEED: 1 << 11,
} as const;

/** path 超速触发线（格/秒）+ 时长守卫（ms）——短局甩鼠标可瞬时超速，不判 */
export const PATH_SPEED_TRIGGER = 30;
export const PATH_SPEED_MIN_TIME_MS = 30000;

/** press-release 分级阈值（ms）——初级/中级 45（2026-10-19 张老师晚定：中级从 56 放宽），
 *  高级 60；初/中锚定 P0 回测人类 p1 分位 44.3 / 55.9 取整收紧，高级沿用原线 */
export const PRESS_AVG_MS: Record<string, number> = { beg: 45, int: 45, exp: 60 };

/** STNB 分级阈值（各级 p99 取整上浮） */
export const STNB_TRIGGER: Record<string, number> = { beg: 205, int: 160, exp: 150 };
