// 一次性重算脚本（2026-10-16 拔旗口径修复的全量回填）：
// 全站用固定后的引擎重放，把受影响的 10 列
// （cl / cl_left / cl_right / cl_double / ce / unflag / corr / ioe / cls / ppc）
// 批量写回。INSERT 段给全 NOT NULL 列（严格模式下 ODKU 也校验插入段，1364 坑），
// 更新段只覆盖 10 个目标列。
// 不动 path / bvs / stnb / real_time / bbbv：path 只累加鼠标行程与点击分类无关，
// bvs/stnb 只依赖 (level, bbbv, real_time)，输入未变 → 值不变，等价于全量重跑。
//
// 用法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/recalc-unflag-fix.ts [--limit=N] [--dry]
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { VIDEO_STATUS } from "../src/lib/config";
import { parseVideoBinary, replayEvents } from "../src/lib/videoradar";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

const arg = (name: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const dry = process.argv.includes("--dry");

interface Row {
  id: bigint;
  filepath: string;
  level: string;
  noflag: number;
  real_time: number;
  bbbv: number;
  path: number;
  bvs: number;
  stnb: number;
  create_time: bigint;
}

async function main() {
  const limit = Number(arg("limit") ?? 0);
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT vm.id, vi.filepath, vm.level, vm.noflag+0 AS noflag, vm.real_time, vm.bbbv, vm.path, vm.bvs, vm.stnb, vm.create_time
       FROM video_metrics vm
       JOIN video_info vi ON vi.id = vm.id
       JOIN video v ON v.id = vm.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND vm.cl > 0
      ${limit > 0 ? `LIMIT ${limit}` : ""}`
  );
  console.log(`待重算：${rows.length} 行（${dry ? "DRY（不写库）" : "写库"}）`);

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const CHUNK = 1000;
  let done = 0, noFile = 0, parseFail = 0, corrGt1 = 0;
  const bad: string[] = [];

  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const values: string[] = [];
    for (const r of part) {
      let buf: Buffer;
      try {
        buf = readFileSync(path.resolve(VIDEOS_ROOT, "." + r.filepath));
      } catch { noFile++; continue; }
      const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
      const v = parseVideoBinary(new Uint8Array(buf), ext);
      if (!v) { parseFail++; continue; }
      const c = replayEvents(v);
      const cl = c.clLeft + c.clRight + c.clDouble;
      const corr = cl > 0 ? r3(c.ce / cl) : 0;
      if (corr > 1) { corrGt1++; if (bad.length < 10) bad.push(`${r.id}:${corr}`); }
      const ioe = cl > 0 ? r3(r.bbbv / cl) : 0;
      const t = r.real_time / 1000;
      const cls = t >= 0.01 ? r3(cl / t) : 0;
      const ppc = cl > 0 ? r3(r.path / cl) : 0;
      values.push(
        `(${r.id},'${r.level}',${r.noflag},${r.real_time},${r.bbbv},${cl},${c.clLeft},${c.clRight},${c.clDouble},${c.ce},${c.unflag},${r.path},${r.bvs},${ioe},${corr},${cls},${ppc},${r.stnb},${r.create_time})`
      );
    }
    if (values.length && !dry) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO video_metrics
           (id, level, noflag, real_time, bbbv, cl, cl_left, cl_right, cl_double, ce, unflag, path, bvs, ioe, corr, cls, ppc, stnb, create_time)
         VALUES ${values.join(",")}
         ON DUPLICATE KEY UPDATE cl=VALUES(cl), cl_left=VALUES(cl_left), cl_right=VALUES(cl_right),
           cl_double=VALUES(cl_double), ce=VALUES(ce), unflag=VALUES(unflag), corr=VALUES(corr),
           ioe=VALUES(ioe), cls=VALUES(cls), ppc=VALUES(ppc)`
      );
    }
    done += part.length;
    if ((i / CHUNK) % 20 === 0) console.log(`  ...${done}/${rows.length}（noFile ${noFile} / parseFail ${parseFail}）`);
  }
  console.log(`完成：处理 ${done} 行，noFile ${noFile}，parseFail ${parseFail}`);
  if (corrGt1) console.log(`⚠️ 重放后仍 corr>1：${corrGt1} 行（${bad.join(", ")}）`);
  else console.log("重放后 corr>1：0 ✓");
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
