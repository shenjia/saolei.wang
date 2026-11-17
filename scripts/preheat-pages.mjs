#!/usr/bin/env node
// 页缓存预热器（2026-11-09 张老师要求）：匿名扫雷闸上线后，nginx 页缓存未命中的
// 首个请求若来自匿名游客会被 307 进验证，而 307 不落 nginx 缓存（proxy_cache_valid
// 未列 307）——缓存一旦过期便永远无法被匿名流量回填，之后每个游客都撞闸。
// 本进程用「通行证 cookie」（与 src/lib/bot-challenge.ts 同源 HMAC 签名，UA 绑定一致）
// 周期性经 nginx 回源拉取关键列表页：canUseRsc 通过 → 源站 200 → nginx 落缓存 →
// 对游客恒为命中，永不触发闸。
// ⚠️ 签名口径必须与 bot-challenge.ts 保持一致：uaHash 取 UA 前 256 字节 sha256
// base64url 截 22 位；JWT header/body 键序 {alg,typ}/{typ,sub,ua,exp}；
// 密钥派生 `${AUTH_SECRET}:rsc-pass-v1`。改动签名逻辑须两处同步。
// 运行：pm2 start scripts/preheat-pages.mjs --name saolei-preheat（服务器 deploy 用户）

import { createHmac, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 页缓存 TTL 200=60s；nginx 已挂 proxy_cache_background_update（2026-11-16），
// 过期由 STALE 秒回+后台刷新兜底（lock 保证每 60s 窗口至多一次渲染，与拍频无关）。
// 本间隔只决定：①preheat 自身的回源字节成本 ②零访客时段的保温保底——
// 179s 拍频请求次数 -67%（2026-11-17 张老师定：新鲜度口径放宽，配 gzip 降字节，
// preheat 单日 1.22GB→约 60MB）。覆盖首页+各列表入口（首页另有豁免自愈）
// ⚠️ curl 必须带 Accept-Encoding: gzip（2026-11-17）：不带时 nginx 页缓存 HIT
// 按明文全量重发（均压 112KB），是 preheat 流量大头；带 A-E 后出站由 nginx gzip
// 压缩（~15KB，-84%）。缓存形态由 nginx 侧 proxy_set_header Accept-Encoding ""
// 锁定为明文（键不含 A-E，若不锁定，带 A-E 请求会把缓存条目写成 gzip，不带
// A-E 的老客户端命中即乱码）——两侧改动成套上线，缺一不可。
const PAGES = ["/", "/video", "/bbs", "/ranking", "/online", "/page/help"];
const INTERVAL_MS = 179_000;
const UA = "saolei-preheat/1";
const HOST = "saolei.wang";

function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const m = env.match(/^AUTH_SECRET=(.*)$/m);
  if (!m) throw new Error("AUTH_SECRET 未找到（env 或 ../.env）");
  return m[1].trim();
}

const b64u = (s) => Buffer.from(s).toString("base64url");

function signPayload(payload, secretKey) {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", secretKey).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const uaHash = (ua) => createHash("sha256").update(ua.slice(0, 256)).digest("base64url").slice(0, 22);

function passCookies(secret) {
  const owner = randomBytes(16).toString("hex");
  const pass = signPayload(
    { typ: "rsc-pass-v1", sub: owner, ua: uaHash(UA), exp: Math.floor(Date.now() / 1000) + 3600 },
    `${secret}:rsc-pass-v1`,
  );
  return `saolei_rsc_id=${owner}; saolei_rsc_pass=${pass}`;
}

function preheat(secret) {
  const cookie = passCookies(secret);
  for (const p of PAGES) {
    try {
      execFileSync(
        "curl",
        ["-sf", "-o", "/dev/null", "-A", UA, "-H", "Accept-Encoding: gzip",
         "-H", `Cookie: ${cookie}`,
         "--resolve", `${HOST}:443:127.0.0.1`, `https://${HOST}${p}`],
        { timeout: 15_000 },
      );
    } catch {
      // 只记失败：成功是常态不刷日志；连续失败多半是部署重启窗口或 nginx 异常
      console.log(`[preheat] ${new Date().toISOString()} FAIL ${p}`);
    }
  }
}

const secret = authSecret();
preheat(secret);
setInterval(() => preheat(secret), INTERVAL_MS);
console.log(`[preheat] started: ${PAGES.length} pages / ${INTERVAL_MS / 1000}s`);
