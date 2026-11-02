// parity 测试：canonicalizeOnlineEvents 修复后，canonical 流与原始流的 flop 计数必须一致
// 聚焦 Right/wastedRight（353011 案幻影右键）；S5 的 Left 差异是 352535 案已接受的口径，不在此断言
import { canonicalizeOnlineEvents, type CanonicalizeCtx, type OnlineEvent } from "../src/lib/avfwrite";
import { replayCounts, MOUSE_CODE_TO_EV, type NormEvent } from "../src/lib/replay-core";

const W = 9, H = 9;
const board = new Uint8Array(W * H);
// 10 雷集中在右下 + 边角，(0,0) 为 0 号可泛洪但远不至于一泛洪开满全盘触发胜利
for (const [mx, my] of [[6, 2], [7, 2], [8, 2], [6, 3], [8, 3], [6, 4], [7, 4], [8, 4], [4, 7], [0, 8]] as const) {
  board[my * W + mx] = 1;
}
const ctx: CanonicalizeCtx = { width: W, height: H, board, questionMarks: false };
let t = 0;
const ev = (mouse: number, cx: number, cy: number): OnlineEvent => {
  t += 50;
  return { mouse, x: cx * 16 + 8, y: cy * 16 + 8, sec: Math.floor(t / 1000), hun: Math.floor(t / 10) % 100, ms: t };
};
const toNorm = (events: OnlineEvent[]): NormEvent[] =>
  events.map((e) => ({ ev: MOUSE_CODE_TO_EV[e.mouse] ?? "mv", x: (e.x / 16) | 0, y: (e.y / 16) | 0, px: e.x, py: e.y }));
const countNorm = (norm: NormEvent[]) => replayCounts({ width: W, height: H, mines: 10, board }, norm);

function counts(events: OnlineEvent[], c: CanonicalizeCtx | undefined) {
  const canon = canonicalizeOnlineEvents(events, c);
  return { ...countNorm(toNorm(canon)), stream: canon.map((e) => e.mouse).join(",") };
}

let failed = 0;
function check(name: string, raw: OnlineEvent[], fields: string[]) {
  const a = counts(raw, ctx);
  const b = countNorm(toNorm(raw)) as unknown as Record<string, number>;
  const bad = fields.filter((f) => (a as unknown as Record<string, number>)[f] !== b[f]);
  if (bad.length) {
    failed++;
    console.log(`✗ ${name}: canonical[${bad.map((f) => `${f}=${(a as unknown as Record<string, number>)[f]}`).join(" ")}] vs raw[${bad.map((f) => `${f}=${b[f]}`).join(" ")}]`);
  } else {
    console.log(`✓ ${name} (Left=${b.clLeft} Right=${b.clRight} Double=${b.clDouble} wastedR=${b.wastedRight})`);
  }
}

// 开局：左键开 (0,0)（0 号泛洪，不会开满全盘）
const open = () => [ev(3, 0, 0), ev(5, 0, 0)];

// S1 幻影主案：已开格上按右键(挂rv) → lc+lr chord（mouse5 折叠）→ rr
check("S1 rc挂rv+lc/lr折叠chord", [...open(), ev(9, 0, 0), ev(3, 0, 0), ev(5, 0, 0), ev(17, 0, 0)],
  ["clRight", "wastedRight", "clDouble", "ce"]);

// S2 幻影变体：挂rv → sc+lr（单击数字口径折叠）→ rr
check("S2 rc挂rv+sc/lr折叠chord", [...open(), ev(9, 0, 0), ev(11, 0, 0), ev(5, 0, 0), ev(17, 0, 0)],
  ["clRight", "wastedRight", "clDouble", "ce"]);

// S3 裸误点：挂rv → rr（无中间动作，flop 照计 wasted，两侧都必须计）
check("S3 裸误点 rc+rr", [...open(), ev(9, 0, 0), ev(17, 0, 0)],
  ["clRight", "wastedRight", "clDouble", "ce"]);

// S4 右先插旗+chord：rc 插旗成功（Right+1 必须保留）→ lc+lr chord → rr
check("S4 rc插旗+chord", [...open(), ev(9, 6, 2), ev(3, 0, 0), ev(5, 0, 0), ev(17, 0, 0)],
  ["clRight", "wastedRight", "clDouble", "ce"]);

// S5 右先松折叠（mouse17lp 分支）：挂rv → lc → rr(chord) → lr
check("S5 rc挂rv+lc+rr折叠+lr", [...open(), ev(9, 0, 0), ev(3, 0, 0), ev(17, 0, 0), ev(5, 0, 0)],
  ["clRight", "wastedRight", "ce"]);

// S6 连续 chord：挂rv → lc+lr(chord1)+lc+lr(chord2) → rr
check("S6 rc挂rv+连续两次chord", [...open(), ev(9, 0, 0), ev(3, 0, 0), ev(5, 0, 0), ev(3, 1, 0), ev(5, 1, 0), ev(17, 0, 0)],
  ["clRight", "wastedRight", "clDouble", "ce"]);

// S7 OOB 挂rv + 折叠
check("S7 OOB rc挂rv+chord折叠", [...open(), ev(9, 12, 3), ev(3, 0, 0), ev(5, 0, 0), ev(17, 12, 3)],
  ["clRight", "wastedRight", "ce"]);

// S8 幂等性：对已 canonical 的流再跑一遍，计数不变
{
  const raw = [...open(), ev(9, 0, 0), ev(3, 0, 0), ev(5, 0, 0), ev(17, 0, 0)];
  const once = counts(raw, ctx);
  const twice = countNorm(toNorm(canonicalizeOnlineEvents(canonicalizeOnlineEvents(raw, ctx), ctx)));
  const f = (r: ReturnType<typeof countNorm>) => ({ L: r.clLeft, R: r.clRight, D: r.clDouble, ce: r.ce });
  const same = JSON.stringify(f(once)) === JSON.stringify(f(twice));
  if (same) console.log(`✓ S8 幂等性 (Right=${once.clRight} Double=${once.clDouble})`);
  else { failed++; console.log(`✗ S8 幂等性: once=${JSON.stringify(f(once))} twice=${JSON.stringify(f(twice))}`); }
}

// S9 无 ctx（旧路径）：保持旧行为不崩
{
  const raw = [...open(), ev(9, 0, 0), ev(3, 0, 0), ev(5, 0, 0), ev(17, 0, 0)];
  const c = counts(raw, undefined);
  console.log(`✓ S9 无ctx旧行为 (stream=${c.stream} Right=${c.clRight} Double=${c.clDouble})`);
}

process.exit(failed ? 1 : 0);
