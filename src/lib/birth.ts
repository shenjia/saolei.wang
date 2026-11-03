// 生日（user_info.birthday，Unix 秒）→ 年龄 / 星座（2026-11-03 张老师要求）：
//   账户设置页英文名后、个人主页「个人资料」昵称行下显示「39 天蝎座」样式。
// 未填生日（0）/ 生日异常（未来日期、超龄）返回 null，调用方整行不渲染。

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

/** 周岁（当年生日未过减一）；未填/异常返回 null */
export function ageFromBirthday(ts: bigint | number | null | undefined, now = new Date()): number | null {
  const sec = Number(ts ?? 0);
  if (!sec) return null;
  const d = new Date(sec * 1000);
  const age =
    now.getFullYear() - d.getFullYear() -
    (now.getMonth() < d.getMonth() ||
    (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())
      ? 1
      : 0);
  return age >= 0 && age < 130 ? age : null;
}

/** 「39 天蝎座」组合文本；未填/异常返回 null */
export function ageConstellationText(ts: bigint | number | null | undefined): string | null {
  const age = ageFromBirthday(ts);
  if (age === null) return null;
  const d = new Date(Number(ts) * 1000);
  return `${age} ${constellationOf(d.getMonth() + 1, d.getDate())}`;
}
