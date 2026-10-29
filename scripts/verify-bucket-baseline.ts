// 端到端验证 getBaseline 桶选：抽三盘不同 3BV 的录像，核对返回 dists 与桶行一致
import { prisma } from "../src/lib/db";
import { getVideoAnalysis } from "../src/lib/videoanalysis";
import { bucketOf } from "../src/lib/videoscore";

async function main() {
  const rows = await prisma.$queryRaw<{ id: bigint; level: string; noflag: boolean; bbbv: number }[]>`
    SELECT m.id, m.level, m.noflag, m.bbbv FROM video_metrics m
    JOIN video v ON v.id = m.id
    WHERE m.cp > 0 AND v.status = 20 AND m.level IN ('beg','int','exp') AND m.cl > 0
    ORDER BY m.bbbv ASC LIMIT 1`;
  const rows2 = await prisma.$queryRaw<{ id: bigint; level: string; noflag: boolean; bbbv: number }[]>`
    SELECT m.id, m.level, m.noflag, m.bbbv FROM video_metrics m
    JOIN video v ON v.id = m.id
    WHERE m.cp > 0 AND v.status = 20 AND m.level = 'exp' AND m.cl > 0
    ORDER BY m.bbbv DESC LIMIT 1`;
  const cases = [...rows, ...rows2];
  for (const r of cases) {
    const res = await getVideoAnalysis({
      id: Number(r.id),
      level: r.level,
      noflag: Boolean(Number(r.noflag)),
      bbbv: r.bbbv,
      realTime: 1000,
      filepath: "",
    });
    const bucket = bucketOf(r.level, r.bbbv);
    const dist = await prisma.videoMetricDist.findUnique({
      where: { level_noflag_bucket: { level: r.level, noflag: Boolean(Number(r.noflag)), bucket } },
    });
    const expect = dist ? String(Math.round(Number(dist.bpp.split(",")[0]) * 1000) / 1000) : "无桶行";
    const got = res?.dists.bpp?.length ? String(res.dists.bpp[0]) : "无";
    const match = expect === got;
    console.log(
      `id=${r.id} ${r.level}${Number(r.noflag) ? "-NF" : "-FL"} bbbv=${r.bbbv} → bucket=${bucket} | 桶行 bpp[0]=${expect} | getVideoAnalysis=${got} | ${match ? "OK" : "MISMATCH"}`,
    );
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
