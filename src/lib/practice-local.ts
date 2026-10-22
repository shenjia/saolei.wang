// 未登录练习记数（2026-10-22 张老师要求）：「今日练习」板块未登录也要显示「我的局数」。
// practice_log 的游客局 user_id 为 NULL 无法归属到人，改记 localStorage：
// · 键 practice_today_count 存 { "YYYY-MM-DD": 局数 }，只保留当天键（次日自动归零，旧键覆写清除）
// · 写入点在 OnlinePlay report() 与埋点同处：胜局立即 +1；败局在 300ms 复活窗结束后 +1
//   （复活撤销计时器＝本局未终态，不计数），与「终态局」口径一致
// · 仅客户端调用（localStorage），服务端组件不得直接 import 使用

const KEY = "practice_today_count";

/** 自定义事件名（PracticeToday useSyncExternalStore 订阅用；bump 后同窗口即时通知） */
export const practiceLocalKey = "practice-local-changed";

/** 本地日期键 YYYY-MM-DD（本地时区，不用 toISOString——那是 UTC 会错切一天） */
const todayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 局终 +1（只保留当天键，防存储膨胀）；派发自定义事件让首页板块即时刷新 */
export function bumpLocalPractice(): void {
  try {
    const k = todayKey();
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, number>;
    localStorage.setItem(KEY, JSON.stringify({ [k]: (Number(raw[k]) || 0) + 1 }));
    window.dispatchEvent(new Event(practiceLocalKey));
  } catch {
    /* 隐私模式/禁用 localStorage：静默放弃，不影响游戏 */
  }
}

/** 读今天已练局数（无记录 0） */
export function getLocalPractice(): number {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, number>;
    return Number(raw[todayKey()]) || 0;
  } catch {
    return 0;
  }
}
