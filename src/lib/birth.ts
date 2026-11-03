// 生日（user_info.birthday，Unix 秒）→ 年龄 / 星座（2026-11-03 张老师要求）：
//   账户设置页英文名后、个人主页「个人资料」昵称行下、后台玩家详情「个人资料」卡
//   各显示「年龄」「星座」两个独立行（2026-11-03 二改：星座独立成行，不与年龄同格）。
// 未填生日（0）/ 旧站默认 1980-01-01 / 生日异常（超界年份）一律视为未填，
// 返回 null，调用方整行不渲染（后台显示「—」）。

/** 旧站默认生日＝1980-01-01（北京时间零点，315504000）：未填生日的用户被旧站批量写入该值
 *  （生产 553 人，2026-11-03 张老师确认并已全部清零），保留判定兜底同步管线带回的旧值 */
export const LEGACY_DEFAULT_BIRTHDAY = 315504000;

/** 星座边界表：[月, 日, 星座名]——生日在该日（含）之前属该星座，之后属下一个 */
const CONSTELLATION_CUTS: [number, number, string][] = [
  [1, 19, "摩羯座"],
  [2, 18, "水瓶座"],
  [3, 20, "双鱼座"],
  [4, 19, "白羊座"],
  [5, 20, "金牛座"],
  [6, 21, "双子座"],
  [7, 22, "巨蟹座"],
  [8, 22, "狮子座"],
  [9, 22, "处女座"],
  [10, 23, "天秤座"],
  [11, 22, "天蝎座"],
  [12, 21, "射手座"],
  [12, 31, "摩羯座"],
];

export function constellationOf(month: number, day: number): string {
  for (const [m, d, name] of CONSTELLATION_CUTS) {
    if (month < m || (month === m && day <= d)) return name;
  }
  return "摩羯座";
}

/** 有效生日 Date；未填/旧站默认/异常返回 null */
function birthDateOf(ts: bigint | number | null | undefined): Date | null {
  const sec = Number(ts ?? 0);
  if (!sec || sec === LEGACY_DEFAULT_BIRTHDAY) return null;
  const d = new Date(sec * 1000);
  const year = d.getFullYear();
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return d;
}

/** 周岁（当年生日未过减一）；未填/异常返回 null */
export function ageOf(ts: bigint | number | null | undefined, now = new Date()): number | null {
  const d = birthDateOf(ts);
  if (!d) return null;
  const age =
    now.getFullYear() - d.getFullYear() -
    (now.getMonth() < d.getMonth() ||
    (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())
      ? 1
      : 0);
  return age >= 0 && age < 130 ? age : null;
}

/** 星座名（如「射手座」）；未填/异常返回 null */
export function constellationText(ts: bigint | number | null | undefined): string | null {
  const d = birthDateOf(ts);
  if (!d) return null;
  return constellationOf(d.getMonth() + 1, d.getDate());
}
