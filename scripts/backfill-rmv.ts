// 回填 258 条 RMV：video_info.board（空→现解析）+ video_metrics（缺行→补）
// 用法：env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/backfill-rmv.ts
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { analyzeVideo, parseVideoBinary } from "../src/lib/videoradar";
import { VIDEO_STATUS } from "../src/lib/config";

const ROOT = path.join(process.cwd(), "videos");

async function main() {
  const infos = await prisma.videoInfo.findMany({
    where: { filepath: { endsWith: ".rmv" } },
    select: { id: true, filepath: true, noflag: true, board3bv: true, realTime: true, board: true },
  });
  const videos = await prisma.video.findMany({
    where: { id: { in: infos.map((i) => i.id) } },
    select: { id: true, level: true, status: true },
  });
  const meta = new Map(videos.map((v) => [v.id.toString(), v]));
  const metricsIds = new Set(
    (await prisma.videoMetrics.findMany({ select: { id: true }, where: { id: { in: infos.map((i) => i.id) } } })).map((r) => r.id.toString())
  );

  let boardOk = 0, boardSkip = 0;
  let metricOk = 0, metricSkip = 0, fail = 0;
  for (const info of infos) {
    const v = meta.get(info.id.toString());
    if (!v || v.status !== VIDEO_STATUS.REVIEWED) continue;

    let buf: Uint8Array | null = null;
    try {
      const full = path.resolve(ROOT, "." + info.filepath);
      if (!full.startsWith(ROOT + path.sep)) throw new Error("path");
      buf = new Uint8Array(readFileSync(full));
    } catch { buf = null; }

    // ① board 回填（空才补）
    if (!info.board) {
      if (!buf) { boardSkip++; continue; }
      const pv = parseVideoBinary(buf, "rmv");
      if (pv && pv.board && pv.board.length === pv.width * pv.height) {
        await prisma.videoInfo.update({ where: { id: info.id }, data: { board: pv.board } });
        boardOk++;
      } else boardSkip++;
    }

    // ② metrics 回填（缺行才补）
    if (metricsIds.has(info.id.toString())) continue;
    if (!buf) { fail++; continue; }
    const m = analyzeVideo(buf, "rmv", {
      level: v.level,
      noflag: info.noflag,
      bbbvFallback: info.board3bv,
      timeMs: info.realTime,
      bbbv: info.board3bv,
    });
    if (!m) { fail++; continue; }
    await prisma.videoMetrics.upsert({
      where: { id: info.id },
      create: {
        id: info.id, level: m.level, noflag: m.noflag, realTime: info.realTime, bbbv: m.bbbv,
        cl: m.cl, clLeft: m.clLeft, clRight: m.clRight, clDouble: m.clDouble, ce: m.ce,
        unflag: m.unflag, path: m.path, bvs: m.bvs, ioe: m.ioe, corr: m.corr, cls: m.cls, ppc: m.ppc,
        thrp: m.thrp, bpp: m.bpp, stnb: m.stnb,
        createTime: BigInt(Math.floor(Date.now() / 1000)),
      },
      update: {},
    });
    metricOk++;
  }
  console.log(`board 回填：${boardOk} 成功 / ${boardSkip} 跳过（解析失败或文件缺失）`);
  console.log(`metrics 回填：${metricOk} 成功 / ${fail} 失败`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("FAIL", e); await prisma.$disconnect(); process.exit(1); });
