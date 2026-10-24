// 快速验证（2026-10-24）：STNB 触发器两条豁免口径
//   ① 初级 3BV<10 不判 ② 可信用户组不判；中级/高级与非常规场景不受影响
import { triageParsed } from "../src/lib/video-triage";

const mk = (bbbv: number | null) => ({
  events: [],
  bbbv,
  timeMs: 60000,
} as unknown as Parameters<typeof triageParsed>[0]);

const metrics = { stnb: 999, cls: 5, path: 100 };

const cases: [string, string, number | null, boolean, number][] = [
  ["初级 3BV=5（运气盘）→ 不判 STNB", "beg", 5, false, 0],
  ["初级 3BV=10（正常盘）→ 判 STNB", "beg", 10, false, 1 << 1],
  ["初级 3BV=5 + 可信用户 → 不判 STNB", "beg", 5, true, 0],
  ["初级 3BV 未知 → 不判 STNB", "beg", null, false, 0],
  ["高级 3BV=3（不限界）→ 判 STNB", "exp", 3, false, 1 << 1],
  ["中级 3BV=2 + 可信用户 → 不判 STNB", "int", 2, true, 0],
];

let fail = 0;
for (const [name, level, bbbv, trusted, expect] of cases) {
  const r = triageParsed(mk(bbbv), level, metrics, false, {}, 60000, trusted);
  const ok = r.reason === expect;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: reason=${r.reason} flag=${r.flag}（期望 reason=${expect}）`);
}
console.log(fail === 0 ? "全部通过" : `${fail} 例失败`);
process.exit(fail === 0 ? 0 : 1);
