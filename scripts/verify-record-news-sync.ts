// 纪录动态链一致化（syncRecordNewsChain）验证脚本（2026-11-01）
// 用法：env -u NODE_OPTIONS npx tsx scripts/verify-record-news-sync.ts
// 全程只读 + 回滚事务，不落任何数据。
// ① 真实玩家（纪录动态最多的 8 人）健康链上重放 → 应零改动（证明重放口径与原发布逻辑一致）
// ② 合成乱序场景（好的先上传后被审）→ 应补缺失点 + 修 or 链（倒挂修复）
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { NEWS_TYPE } from "../src/lib/config";
import { syncRecordNewsChain } from "../src/lib/review";

type Row = { id: number; ref: number; det: string; ct: number; exp: number; ranked: number };

async function readNews(db: Prisma.TransactionClient, uid: number): Promise<Row[]> {
  const rows = await db.news.findMany({
    where: { user: BigInt(uid), type: NEWS_TYPE.PERSON_RECORD },
    select: { id: true, reference: true, detailsData: true, createTime: true, expTime: true, ranked: true },
  });
  return rows
    .map((r) => ({
      id: Number(r.id),
      ref: Number(r.reference),
      det: r.detailsData,
      ct: Number(r.createTime),
      exp: Number(r.expTime),
      ranked: Number(r.ranked),
    }))
    .sort((a, b) => a.id - b.id);
}

const norm = (rows: Row[]) =>
  rows
    .map((r) => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(r.det) as Record<string, unknown>;
      } catch { /* 忽略坏行 */ }
      // 历史行 or/cr 可能是字符串（旧站遗留），Number 归一后比对
      return { id: r.id, ref: r.ref, lv: String(d.lv ?? ""), od: String(d.od ?? ""), or: Number(d.or ?? 0), cr: Number(d.cr ?? 0), nf: Number(d.nf ?? 0), ct: r.ct, exp: r.exp, ranked: r.ranked };
    })
    .sort((a, b) => a.od.localeCompare(b.od) || a.ref - b.ref);
const sigOf = (ns: ReturnType<typeof norm>) => JSON.stringify(ns.map((n) => [n.ref, n.od, n.or, n.cr, n.nf, n.ct, n.exp, n.ranked]));

async function main() {
  // ---- ① 健康链零改动验证 ----
  const tops = await prisma.news.groupBy({
    by: ["user"],
    where: { type: NEWS_TYPE.PERSON_RECORD },
    _count: { _all: true },
    orderBy: { _count: { user: "desc" } },
    take: 8,
  });
  console.log(`== ① 健康链重放验证（纪录动态最多的 ${tops.length} 位玩家，回滚事务）==`);
  let checked = 0;
  for (const t of tops) {
    const uid = Number(t.user);
    const all = await readNews(prisma, uid);
    const levels = new Set<string>();
    for (const r of all) {
      try {
        const d = JSON.parse(r.det) as { lv?: string };
        if (d.lv) levels.add(d.lv);
      } catch { /* 忽略坏行 */ }
    }
    for (const level of levels) {
      const before = norm(all);
      let after: ReturnType<typeof norm> = [];
      await prisma.$transaction(async (tx) => {
        await syncRecordNewsChain(tx, uid, level as "beg" | "int" | "exp", { expTime: 0 });
        after = norm(await readNews(tx, uid));
        throw new Error("__rollback__");
      }).catch((e) => {
        if ((e as Error).message !== "__rollback__") throw e;
      });
      // 只比本级别的行（sync 只动本级别）
      const b = before.filter((r) => r.lv === level);
      const a = after.filter((r) => r.lv === level);
      const ok = sigOf(b) === sigOf(a);
      checked++;
      console.log(`  user#${uid} ${level}: news=${b.length} ${ok ? "✅ 零改动" : `❌ 差异 ${b.length}→${a.length} 行`}`);
      if (!ok) {
        const key = (r: { ref: number; od: string }) => `${r.od}:${r.ref}`;
        const bmap = new Map(b.map((r) => [key(r), r]));
        const amap = new Map(a.map((r) => [key(r), r]));
        for (const [k, r] of bmap) {
          const o = amap.get(k);
          if (!o) console.log(`    - 删 ${k} or=${r.or} cr=${r.cr}`);
          else if (sigOf([r]) !== sigOf([o])) console.log(`    - 改 ${k} or=${r.or}→${o.or} cr=${r.cr}→${o.cr}`);
        }
        for (const [k, r] of amap) if (!bmap.has(k)) console.log(`    + 补 ${k} or=${r.or} cr=${r.cr} ct=${r.ct}`);
      }
    }
  }
  console.log(`  共核对 ${checked} 条链`);

  // ---- ② 合成乱序场景验证 ----
  console.log("== ② 乱序场景（v1=50s@T1 先上传、v2=45s@T2 后上传；45s 先审已发 or=60000）==");
  // 找一个在 beg 级别无任何纪录动态的在榜用户
  const cand = await prisma.$queryRaw<{ uid: bigint; status: number }[]>`
    SELECT u.id uid, u.status FROM \`user\` u
    WHERE u.status = 0 AND NOT EXISTS (
      SELECT 1 FROM news n WHERE n.\`user\` = u.id AND n.type = ${NEWS_TYPE.PERSON_RECORD}
      AND n.details_data LIKE '%"lv":"beg"%'
    ) LIMIT 1`;
  const uid = Number(cand[0].uid);
  if (!uid) {
    console.log("  找不到候选用户，跳过");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const T1 = now - 7200;
  const T2 = now - 3600;
  await prisma.$transaction(async (tx) => {
    // 三条合成成绩：v0=60000ms@T0（既有纪录，真实场景必有成绩表行）、
    // v1=50000ms@T1（更好成绩但上传早）、v2=45000ms@T2
    await tx.videoScoresBeg.create({ data: { id: BigInt(990000000), user: BigInt(uid), scoreTime: 60000, score3bvs: 60, createTime: BigInt(T1 - 3600) } });
    await tx.videoScoresBeg.create({ data: { id: BigInt(990000001), user: BigInt(uid), scoreTime: 50000, score3bvs: 100, createTime: BigInt(T1) } });
    await tx.videoScoresBeg.create({ data: { id: BigInt(990000002), user: BigInt(uid), scoreTime: 45000, score3bvs: 90, createTime: BigInt(T2) } });
    // 预置「乱序审」产物：v2 先审时发的纪录动态（or=60000 旧纪录，时间=T2）
    await tx.news.create({
      data: {
        type: NEWS_TYPE.PERSON_RECORD, user: BigInt(uid), expTime: BigInt(0), ranked: BigInt(1),
        reference: BigInt(990000002),
        detailsData: JSON.stringify({ lv: "beg", od: "time", or: 60000, cr: 45000, nf: 0 }),
        createTime: BigInt(T2),
      },
    });
    await syncRecordNewsChain(tx, uid, "beg", { expTime: 0 });
    const rows = await readNews(tx, uid);
    console.log(`  重放后 ${rows.length} 条（期望 3 条：60s@T0 首创 or=0；50s@T1 补发 or=60000；45s@T2 or 修为 50000）`);
    for (const r of rows) console.log(`   - ref=${r.ref} ct=${r.ct} ${r.det}`);
    const n0 = rows.find((r) => r.ref === 990000000);
    const n1 = rows.find((r) => r.ref === 990000001);
    const n2 = rows.find((r) => r.ref === 990000002);
    const d0 = n0 ? (JSON.parse(n0.det) as { or: number; cr: number }) : null;
    const d1 = n1 ? (JSON.parse(n1.det) as { or: number; cr: number }) : null;
    const d2 = n2 ? (JSON.parse(n2.det) as { or: number; cr: number }) : null;
    const ok =
      !!n0 && !!n1 && !!n2 &&
      n0.ct === T1 - 3600 && d0?.or === 0 && d0.cr === 60000 &&
      n1.ct === T1 && d1?.or === 60000 && d1.cr === 50000 &&
      n2.ct === T2 && d2?.or === 50000 && d2.cr === 45000;
    console.log(`  ${ok ? "✅ 链条修复正确（时间升序 + or 链自洽）" : "❌ 不符合预期"}`);
    throw new Error("__rollback__");
  }).catch((e) => {
    if ((e as Error).message !== "__rollback__") throw e;
  });
  console.log("（全部回滚，未落库）");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
