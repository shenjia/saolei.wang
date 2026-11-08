// 离线生成 100 张标准初级验证盘；仅在更新题库时运行，线上绝不执行。
// 数据源是本地录像副本中的既有低 3BV 盘面，只保存雷位/数字/opening，不带玩家或录像 ID。
import { writeFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import {
  captcha3BV,
  captchaNeighbors,
  captchaNumbers,
  instantiateCaptchaGame,
  type CaptchaSeed,
} from "../src/core/src/lib/captcha-board";

async function main() {
const rows = await prisma.$queryRaw<Array<{ board: string }>>`
  SELECT DISTINCT vi.board
  FROM video_info vi JOIN video v ON v.id=vi.id
  WHERE v.level='beg' AND vi.board_3bv<4 AND vi.board<>''
  LIMIT 1500
`;

const unique = new Set<string>();
const seeds: CaptchaSeed[] = [];
for (const row of rows) {
  const raw = row.board;
  if (raw.length !== 64 || unique.has(raw)) continue;
  const mines = Array.from(raw, (ch): number => (ch === "*" ? 1 : 0));
  if (mines.reduce((a, b) => a + b, 0) !== 10) continue;
  const nums = captchaNumbers(mines);
  const board3bv = captcha3BV(mines, nums, 8, 8);
  if (board3bv >= 4) continue;
  const openings = nums.map((n, i) => (n === 0 && !mines[i] ? i : -1)).filter((i) => i >= 0);
  // 优先中央 opening，避免过小的边角展开；每盘只保留固定一个，线上零随机计算。
  openings.sort((a, b) => {
    const score = (i: number) => Math.abs((i % 8) - 3.5) + Math.abs(Math.floor(i / 8) - 3.5);
    return score(a) - score(b) || a - b;
  });
  let seed: CaptchaSeed | null = null;
  for (const opening of openings) {
    const candidate = { mines, nums, opening, board3bv };
    const game = instantiateCaptchaGame(candidate, "precheck", Date.now());
    if (!game.won && game.openedSafe >= 8) {
      seed = candidate;
      break;
    }
  }
  if (!seed) continue;
  unique.add(raw);
  seeds.push(seed);
  if (seeds.length === 100) break;
}
if (seeds.length !== 100) throw new Error(`合格盘面不足：${seeds.length}/100`);

const output = new URL("../src/core/src/lib/captcha-boards.json", import.meta.url);
writeFileSync(output, `${JSON.stringify(seeds)}\n`, "utf8");
console.log(`generated ${seeds.length} boards -> ${output.pathname}`);
console.log(`3BV distribution: ${JSON.stringify(seeds.reduce<Record<string, number>>((acc, s) => {
  acc[s.board3bv] = (acc[s.board3bv] ?? 0) + 1;
  return acc;
}, {}))}`);
await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
