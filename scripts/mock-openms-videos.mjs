// 开源扫雷网「未映射录像查询 API」本地 mock（2026-11-10 按对方定稿字段对齐）
// 用法：node scripts/mock-openms-videos.mjs  → 127.0.0.1:9998
// 联调：OPENMS_BASE=http://127.0.0.1:9998 OPENMS_UID_SOURCE=profile scripts/... --users 9952:2
// 环境变量：
//   MOCK_TOTAL       假录像总数，默认 250（video_id 1..N）
//   MOCK_SAOLEI_ID   返回的 saolei_id（雷网 uid），默认 9952
//   MOCK_PROFILE     接受的 user_id（开源站 UserProfile.id），默认 2
//   MOCK_DOWNLOAD_FAIL=1  下载接口一律返回 503，用来验证「临时失败保持 pending、下轮重试」
//   MOCK_GTE=0       改成 id>cursor；默认 1 模拟真实 API 的 inclusive（video_id>=cursor），
//                    用来验证同步脚本「每次请求 +1」不会重复拉最后一条、不会死循环
// 列表接口：GET /api/accountlink/saolei/unmapped_videos?user_id=&cursor=&count=
//   → 裸数组 [{ saolei_id, video_id, upload_time(ISO8601 UTC) }]
// 下载接口：GET /api/video/download/{video_id}（返回占位字节，dry-run 不会用到）
import http from "node:http";

const PORT = 9998;
const TOTAL = Number(process.env.MOCK_TOTAL ?? 250);
const SAOLEI_ID = Number(process.env.MOCK_SAOLEI_ID ?? 9952);
const PROFILE = Number(process.env.MOCK_PROFILE ?? 2);
const GTE = process.env.MOCK_GTE !== "0"; // 默认 inclusive，对齐真实 API
const DL_FAIL = process.env.MOCK_DOWNLOAD_FAIL === "1";

const records = Array.from({ length: TOTAL }, (_, i) => ({
  saolei_id: SAOLEI_ID,
  video_id: i + 1,
  upload_time: new Date(Date.UTC(2025, 2, 14, 6, 8, 31) + i * 3600_000).toISOString(),
}));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (url.pathname === "/api/accountlink/saolei/unmapped_videos") {
    // 真实 API 省略 user_id 会全表扫描超时（nginx 504），此处同样模拟
    if (!url.searchParams.has("user_id")) {
      res.statusCode = 504;
      res.end(JSON.stringify({ error: "gateway timeout (mock: user_id required)" }));
      return;
    }
    const user = Number(url.searchParams.get("user_id"));
    const cursor = Number(url.searchParams.get("cursor") ?? 1);
    const count = Math.min(2000, Math.max(1, Number(url.searchParams.get("count") ?? 1000)));
    const rows = records
      .filter(() => user === PROFILE)
      .filter((r) => (GTE ? r.video_id >= cursor : r.video_id > cursor))
      .slice(0, count);
    res.end(JSON.stringify(rows));
    console.log(`[mock-videos] user_id=${user} cursor=${cursor} count=${count} → ${rows.length} 条 (${rows[0]?.video_id ?? "-"}..${rows.at(-1)?.video_id ?? "-"}) gte=${GTE}`);
    return;
  }
  if (url.pathname.startsWith("/api/video/download/")) {
    if (DL_FAIL) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "mock download temporarily unavailable" }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Disposition", 'attachment; filename="mock.evf"');
    res.end(Buffer.from("MOCK-NOT-A-REAL-VIDEO"));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-videos] listening http://127.0.0.1:${PORT} total=${TOTAL} saolei_id=${SAOLEI_ID} profile=${PROFILE} gte=${GTE}`);
});
