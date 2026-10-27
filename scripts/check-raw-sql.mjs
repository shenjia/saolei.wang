#!/usr/bin/env node
// 裸拼 SQL 护栏（2026-10-27 SQL 注入加固配套）
//
// 为什么需要它：全站有 74 处 $queryRawUnsafe / $executeRawUnsafe。值走 ? 占位符时
// 本身是安全的，真正的风险是「新写一处顺手把参数拼进 SQL 串」——这种改动在 code
// review 里极易漏看（字符串模板看起来都差不多）。所以用一份基线把现有数量钉住：
// 任何新增（新文件出现裸拼、或已有文件数量上涨）都会在这里被点名。
//
// 用法：
//   node scripts/check-raw-sql.mjs            # 比对基线，有新增则退出码 1
//   node scripts/check-raw-sql.mjs --warn     # 只提示不失败（CI 用这个）
//   node scripts/check-raw-sql.mjs --update   # 复核确认无误后刷新基线
//
// 基线文件：scripts/raw-sql-baseline.json（变化会出现在 diff 里，等于强制过一次 review）

import fs from "node:fs";
import path from "node:path";

const ROOT = "src";
const BASELINE = "scripts/raw-sql-baseline.json";
const PATTERN = /\$(?:queryRawUnsafe|executeRawUnsafe)\s*(?:<[^>]*>)?\s*\(/g;

const args = new Set(process.argv.slice(2));
const warnOnly = args.has("--warn");
const update = args.has("--update");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 逐文件统计裸拼 SQL 调用点数量 */
function scan() {
  const files = {};
  let total = 0;
  for (const p of walk(ROOT)) {
    const src = fs.readFileSync(p, "utf8");
    const n = (src.match(PATTERN) ?? []).length;
    if (n > 0) {
      files[p] = n;
      total += n;
    }
  }
  return { total, files };
}

const now = scan();

if (update) {
  const payload = {
    note: "裸拼 SQL 调用点基线（$queryRawUnsafe/$executeRawUnsafe）。新增前请确认值走 ? 占位符、标识符过 assertIdent。",
    generatedAt: new Date().toISOString().slice(0, 10),
    total: now.total,
    files: Object.fromEntries(Object.entries(now.files).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + "\n");
  console.log(`基线已更新：${now.total} 处 / ${Object.keys(now.files).length} 文件 → ${BASELINE}`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.log(`未找到基线 ${BASELINE}，跳过检查（当前 ${now.total} 处）。`);
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const regressions = [];

for (const [file, n] of Object.entries(now.files)) {
  const old = base.files?.[file] ?? 0;
  if (n > old) regressions.push(`新增/增加 ${n - old} 处：${file}（基线 ${old} → 现 ${n}）`);
}
for (const file of Object.keys(base.files ?? {})) {
  if (!(file in now.files)) console.log(`已减少/移除：${file}（基线 ${base.files[file]} → 0）`);
}

const delta = now.total - (base.total ?? 0);

if (!regressions.length && delta <= 0) {
  console.log(`✓ 裸拼 SQL 无新增（${now.total} 处，基线 ${base.total} 处${delta < 0 ? `，已降 ${-delta}` : ""}）`);
  process.exit(0);
}

console.log(`\n✗ 裸拼 SQL 出现新增（${now.total} 处，基线 ${base.total} 处）：`);
for (const r of regressions.sort()) console.log(`  · ${r}`);
console.log(`
如果新增是有意的，请先自检：
  1. 值（用户输入/名称/关键词）是否走 ? 占位符，而不是拼进 SQL 串？
  2. 表名/列名是否经 assertIdent()（src/lib/sqlguard.ts）？
  3. LIKE 参数是否用 likeContains() 转义 %/_ ？
确认后执行 node scripts/check-raw-sql.mjs --update 刷新基线（会进 diff，等于过审）。`);

if (warnOnly) {
  for (const r of regressions.sort()) console.log(`::warning::裸拼 SQL 新增 · ${r}`);
  process.exit(0);
}
process.exit(1);
