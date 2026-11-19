// 旧版称号（2008 版，按高级纪录评定；2026-09-23 排行榜称号列改用此套，张老师要求）
// 规则移植 2008 版 Help/Title.asp：
//   [雷帝] 雷界排行第一人
//   [雷圣] 高级纪录 50 秒以内
//   [雷神] 50~60 秒（GG） / [雷仙] 50~60 秒（mm）
//   [状元] 60~61  [榜眼] 61~63  [探花] 63~66  [进士] 66~70
//   [举人] 70~80  [秀才] 80~90  [书生] 90~100 [童生] 100 秒以上
//   [布衣] 未加入排行

import { OLD_TITLES } from "./config";

const COLOR: Record<string, string> = Object.fromEntries(OLD_TITLES.map((t) => [t.name, t.color]));

export interface OldTitle {
  name: string;
  color: string;
}

/**
 * 计算旧版称号
 * @param expTimeMs 高级纪录（毫秒，0=无成绩）
 * @param sex       1=GG 0=mm
 * @param isFirst   是否雷界排行（总计时间）第一人
 */
export function oldTitle(expTimeMs: number, sex: number, isFirst = false): OldTitle {
  let name: string;
  if (isFirst) name = "雷帝";
  else if (expTimeMs <= 0) name = "布衣";
  else {
    const s = expTimeMs / 1000;
    if (s < 50) name = "雷圣";
    else if (s < 60) name = sex ? "雷神" : "雷仙";
    else if (s < 61) name = "状元";
    else if (s < 63) name = "榜眼";
    else if (s < 66) name = "探花";
    else if (s < 70) name = "进士";
    else if (s < 80) name = "举人";
    else if (s < 90) name = "秀才";
    else if (s < 100) name = "书生";
    else name = "童生";
  }
  return { name, color: COLOR[name] ?? "#BBBBBB" };
}
