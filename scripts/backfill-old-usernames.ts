// 回填 user_auth.old_username（2026-11-09）：绑定邮箱换名导致旧登录名丢失，
// 从 binlog before-image 提取的换名映射（/tmp/username_changes_all.tsv）回填。
// TSV 格式: 时间\tid\told_username\tnew_username（scripts/binlog-username-changes.py 产出）
// 规则：每用户取「最早一次换名的旧名」（= 原 2013 登录名）；old_username 已有值不覆盖；
//       当前 username 已等于旧名（后续改回）则跳过。
// 用法: env -u NODE_OPTIONS node --experimental-transform-types scripts/backfill-old-usernames.ts <tsv路径>
import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tsv = process.argv[2];
  if (!tsv) {
    console.error("用法: node --experimental-transform-types scripts/backfill-old-usernames.ts <tsv路径>");
    process.exit(1);
  }
  const lines = readFileSync(tsv, "utf8").split("\n").filter(Boolean);
  // 按用户分组，取最早一次换名的旧名（binlog 时间天然升序）
  const firstOld = new Map<number, string>();
  for (const line of lines) {
    const [, idStr, oldU, newU] = line.split("\t");
    const id = Number(idStr);
    if (!id || !oldU) continue;
    if (!firstOld.has(id)) firstOld.set(id, oldU);
    void newU;
  }
  console.log(`换名事件 ${lines.length} 条，涉及用户 ${firstOld.size} 个`);

  let filled = 0;
  let skippedHave = 0;
  let skippedSame = 0;
  let missing = 0;
  for (const [id, oldU] of firstOld) {
    const auth = await prisma.userAuth.findUnique({
      where: { id: BigInt(id) },
      select: { username: true, oldUsername: true },
    });
    if (!auth) {
      missing++;
      continue;
    }
    if (auth.username === oldU) {
      // 已经改回/一致，无需记录
      skippedSame++;
      continue;
    }
    if (auth.oldUsername) {
      skippedHave++;
      continue;
    }
    await prisma.userAuth.update({
      where: { id: BigInt(id) },
      data: { oldUsername: oldU },
    });
    filled++;
  }
  console.log(`回填 ${filled}，已有值跳过 ${skippedHave}，当前名一致跳过 ${skippedSame}，无账号记录 ${missing}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
