#!/usr/bin/env node
// 灌入开源扫雷网绑定名单到 openms_link（2026-11-07）
// 数据源：GET https://openms.top/api/userprofile/query?platform=c（公开，60/min，100/页）
// upsert：新绑定插入；已存在的行只刷新 profile，绝不覆盖 consent（用户表态不可被抹掉）
// 用法：node scripts/openms-seed-links.mjs | mysql -uroot saolei
//   （先打印 SQL 到 stdout，由调用方决定是否入库；加 --apply 直接执行）

import { execSync } from "child_process";

const BASE = "https://openms.top";
const now = Math.floor(Date.now() / 1000);

async function fetchPage(page) {
  const r = await fetch(`${BASE}/api/userprofile/query?platform=c&page=${page}&page_size=100`, {
    headers: { "User-Agent": "saolei.wang-sync/1.0" },
  });
  if (!r.ok) throw new Error(`page ${page}: HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const users = [];
  let page = 1;
  for (;;) {
    const j = await fetchPage(page);
    const batch = j.users ?? [];
    if (!batch.length) break;
    users.push(...batch);
    const totalPages = Math.ceil((j.count ?? users.length) / 100);
    console.error(`page ${page}: +${batch.length} (total ${users.length}/${j.count ?? "?"}, pages ${totalPages})`);
    if (page >= totalPages) break;
    page++;
    await new Promise((r) => setTimeout(r, 1100)); // 60/min 限速
  }

  const rows = users
    .filter((u) => u.accounts?.c)
    .map((u) => {
      const uid = BigInt(u.accounts.c);
      const profile = Number(u.id);
      return `INSERT INTO openms_link (user, profile, consent, consent_time, create_time, update_time)
VALUES (${uid}, ${profile}, 0, 0, ${now}, ${now})
ON DUPLICATE KEY UPDATE profile=${profile};`;
    });
  const skipped = users.length - rows.length;
  const sql = `-- openms_link seed @ ${new Date().toISOString()} (${rows.length} rows, ${skipped} skipped)\n${rows.join("\n")}\n`;

  if (process.argv.includes("--apply")) {
    execSync("mysql -uroot saolei", { input: sql, stdio: ["pipe", "ignore", "inherit"] });
    console.error(`applied ${rows.length} rows`);
  } else {
    process.stdout.write(sql);
    console.error(`\n(dry-run：${rows.length} 条 SQL 已打印到 stdout；确认后加 --apply 执行)`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
