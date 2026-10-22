// 未登录练习记数（2026-10-22 张老师要求）：「今日练习」板块未登录也要显示「我的局数」。
// practice_log 的游客局 user_id 为 NULL 无法归属到人，改记 localStorage：
// · 键 practice_today_count 存 { "YYYY-MM-DD": { p: 尝试盘数, w: 完成盘数 } }
//   （p=played 终态局数、w=won 胜局数；2026-10-22 五轮前旧格式为 { 日期: 数字 }——
//    读时数字视为 p、w 补 0 兼容，写入一律新格式）
// · 只保留最近 30 天键（供趋势线取数；更旧的覆写清除，防膨胀）
// · 写入点在 OnlinePlay report() 与埋点同处：胜局立即记；败局在 300ms 复活窗结束后记
//   （复活撤销计时器＝本局未终态，不计数），与「终态局」口径一致
// · 仅客户端调用（localStorage），服务端组件不得直接 import 使用

const KEY = "practice_today_count";

/** 保留天数（与首页 30 天趋势线窗口一致） */
const KEEP_DAYS = 30;

/** 自定义事件名（PracticeToday useSyncExternalStore 订阅用；bump 后同窗口即时通知） */
export const practiceLocalKey = "practice-local-changed";

export interface LocalDayCount {
  /** 尝试盘数（终态局，含踩雷） */
  p: number;
  /** 完成盘数（胜局） */
  w: number;
}

/** 本地日期键 YYYY-MM-DD（本地时区，不用 toISOString——那是 UTC 会错切一天） */
const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const todayKey = (): string => dateKey(new Date());

/** 读全量存储（旧格式数字自动迁移为 { p: n, w: 0 }） */
function readAll(): Record<string, LocalDayCount> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, number | LocalDayCount>;
    const out: Record<string, LocalDayCount> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = typeof v === "number" ? { p: v, w: 0 } : { p: Number(v.p) || 0, w: Number(v.w) || 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写全量存储（只保留最近 KEEP_DAYS 天键） */
function writeAll(data: Record<string, LocalDayCount>): void {
  const keys = Object.keys(data).sort();
  const keep = keys.slice(Math.max(0, keys.length - KEEP_DAYS));
  const trimmed: Record<string, LocalDayCount> = {};
  for (const k of keep) trimmed[k] = data[k];
  localStorage.setItem(KEY, JSON.stringify(trimmed));
}

/** 局终 +1（won=胜局）；派发自定义事件让首页板块即时刷新 */
export function bumpLocalPractice(won: boolean): void {
  try {
    const all = readAll();
    const k = todayKey();
    const day = all[k] ?? { p: 0, w: 0 };
    day.p += 1;
    if (won) day.w += 1;
    all[k] = day;
    writeAll(all);
    window.dispatchEvent(new Event(practiceLocalKey));
  } catch {
    /* 隐私模式/禁用 localStorage：静默放弃，不影响游戏 */
  }
}

/** 读今天的完成/尝试盘数（无记录 0/0） */
export function getLocalPracticeToday(): LocalDayCount {
  return readAll()[todayKey()] ?? { p: 0, w: 0 };
}

/** 近 n 天尝试盘数趋势（旧→新，末位=今天；与服务端趋势桶对齐供双线图共画） */
export function getLocalPracticeTrend(days = KEEP_DAYS): number[] {
  const all = readAll();
  const out: number[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(all[dateKey(d)]?.p ?? 0);
  }
  return out;
}
