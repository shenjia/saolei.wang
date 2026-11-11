// 存量感言回填（2026-11-11 感言改预写制：star_speech 落 user 表每人一份）
// 把 star 行里已有的非空感言按日期升序逐条覆盖写入 user.star_speech（每人最终留最新一条）；
// star.speech_del 按用户取历史最大值回填 user.star_speech_del（删两次封嘴口径延续）。
// 幂等：重复执行结果一致（覆盖写）。生产部署顺序：schema 加列 → 上代码 → 跑本脚本。
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const stars = await prisma.star.findMany({
    where: { speech: { not: "" } },
    orderBy: { date: "asc" },
    select: { user: true, speech: true },
  });
  let n = 0;
  for (const s of stars) {
    await prisma.user.update({
      where: { id: s.user },
      data: { starSpeech: s.speech },
    });
    n++;
    console.log(`speech  user=${s.user} ← "${s.speech}"`);
  }
  const dels = await prisma.star.groupBy({
    by: ["user"],
    _max: { speechDel: true },
    where: { speechDel: { gt: 0 } },
  });
  for (const d of dels) {
    const v = d._max.speechDel ?? 0;
    await prisma.user.update({
      where: { id: d.user },
      data: { starSpeechDel: v },
    });
    console.log(`delCnt  user=${d.user} → ${v}`);
  }
  console.log(`done: ${n} speeches, ${dels.length} del counters`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
