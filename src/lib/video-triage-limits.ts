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
  /** ms-toollib is_valid 判定不通过（2026-10-24 接入，口径见 lib/msvalid.ts）：
   *  软件白名单外 / 校验和为测试值 / 软件判定辅助手段 / 鼠标轨迹程序化特征。
   *  ⚠️ 库白名单止于元3.3.4——元 3.3.5+ 新版本会误报本项，人工复核先看 software */
  MSTOOL_FAIL: 1 << 12,
  /** ms-toollib is_valid 判定可疑：操作细节不足（动作数/3BV<10）或鼠标特征达可疑阈值
   *  （按住时长 30~40ms / 极短按 4~10 次 / 轨迹方向熵/转向熵偏低） */
  MSTOOL_SUSPECT: 1 << 13,
  /** 盲区点击率过低（阈值口径见私有 core）：排名局专属信号，需手审 */
  BLIND_RATE: 1 << 14,
  /** 排名 evf 签名校验失败（2026-10-27）：文件字节与 video_info.evf_sig 的 HMAC 不一致
   *  ——库内文件被替换/篡改。签名缺失（历史数据）不判 */
  EVF_SIG: 1 << 15,
  /** 在线排行模式录像一律转手审（2026-10-27 张老师指令「暂时」）：
   *  不是触发器命中，而是口径强制——开关见 RANKED_FORCE_MANUAL_REVIEW。
   *  关闭开关后本条自然消失（存量的旧位不会自动清，重跑分拣即覆盖） */
  RANKED_MANUAL: 1 << 16,
} as const;

/** 在线排行模式录像全部转手审（临时口径，2026-10-27 张老师指令）
 *  true  → 排名局（software=Saolei.wang / 带 evf_sig）无论触发器是否命中，一律 auto_flag=0 进需核定池
 *  false → 恢复原逻辑（机器只分拣、零命中免核定）
 *  改回 false 后，已打 bit16 的录像需重跑分拣（scripts/ranked-retriage.ts --all）才会回到免核定池 */
export const RANKED_FORCE_MANUAL_REVIEW = true;

/** path 超速触发线（格/秒）+ 时长守卫（ms）——短局甩鼠标可瞬时超速，不判 */
export const PATH_SPEED_TRIGGER = 30;
export const PATH_SPEED_MIN_TIME_MS = 30000;

/** press-release 分级阈值（ms）——初级/中级 45（2026-10-19 张老师晚定：中级从 56 放宽），
 *  高级 60；初/中锚定 P0 回测人类 p1 分位 44.3 / 55.9 取整收紧，高级沿用原线 */
export const PRESS_AVG_MS: Record<string, number> = { beg: 45, int: 45, exp: 60 };

/** STNB 分级阈值（各级 p99 取整上浮） */
export const STNB_TRIGGER: Record<string, number> = { beg: 205, int: 160, exp: 150 };

// 盲区率阈值定义已移入私有 submodule（src/core/src/lib/triage-secret.ts），
// 此处转发符号——阈值与口径注释不再随主仓公开。
export { BLIND_RATE_TRIGGER, BLIND_RATE_MIN_BLINDS, BLIND_RATE_MIN_CLICKS } from "@/core/src/lib/triage-secret";
