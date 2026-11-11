// 练习盘计数采集（2026-10-16 上线；2026-10-22 张老师定：改日汇总表，不再逐盘落行）
// /online 每局结束由 OnlinePlay report() 上报（胜/负都记），uid 服务端从 session 取，
// 不信任客户端。写入 practice_daily：当日当用户一行 UPSERT（plays+1、胜局再 wins+1）；
// 未登录归入 user_id=0 游客聚合行。字段粗校验仅防畸形请求（粉丝站轻量方案）。
// 2026-10-27 加级别三列 plays_beg/int/exp 同步自增（后台「今日练习」KPI 显示
// 初/中/高占比）；自定义盘（cus）只进 plays 总数，不进三列。
// 2026-11-06 加完成盘数分级别四列 wins_beg/int/exp/cus：胜局按 level 自增对应列
// （地区活跃指数/个人主页练习盘数改按完成口径并按难度加权，见 lib/areaactivity.ts）。
// 2026-11-08 加活跃点累计列 act_points：地区活跃指数练习侧改按 3BV 完成情况逐盘点数。
// 2026-11-11 四轮修订（张老师定）：初级胜=1 败=0；中级完成过半（≥50%）按 floor(率×4)，
// 胜局恒=4；高级同口径 floor(率×20)，胜局恒=20；自定义胜=1（录像口径不变）。
// 非排行模式练习（ranked=false）只得 50% 练习点，向下取整——排行模式全额。服务端逐盘计点后累加落库，
// 不信任客户端算好的分；floor 逐盘取整不可反推，故不存 solvedBv/bbbv 原始和。
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { getClientIp, ipToArea } from "@/lib/ip2area";
import { practiceActPoints } from "@/lib/actpoints";

export const runtime = "nodejs";

const LEVELS = new Set(["beg", "int", "exp", "cus"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const level = String(body.level ?? "");
  const csec = Number(body.csec);
  const bbbv = Number(body.bbbv);
  const solvedBv = Number(body.solvedBv);
  const clicks = Number(body.clicks);
  // 模式开关（2026-10-27）：布尔粗校验，缺省 false（老客户端不带这些字段）
  const ranked = body.ranked === true;
  const nfOn = body.nf === true;
  const ngOn = body.ng === true;
  const sqOn = body.sq === true;
  const comboOn = body.combo === true;
  // 设置开关（2026-11-01）：同上缺省 false——老客户端不带，起记日前旧局稀释占比
  // pixelStyle 像素风格（2026-11-10 第七列 sw_pixel，开关 2026-11-09 上线后才统计）
  const swQmark = body.qmark === true;
  const swStats = body.showStats === true;
  const swSndfb = body.sndFb === true;
  const swShot = body.autoShot === true;
  const swQretry = body.quickRetry === true;
  const swWheel = body.wheelZoom === true;
  const swPixel = body.pixelStyle === true;
  if (
    !LEVELS.has(level) ||
    !Number.isFinite(csec) || csec <= 0 || csec > 3_600_000 || // 10 小时封顶
    !Number.isInteger(bbbv) || bbbv < 1 || bbbv > 999 ||
    !Number.isInteger(solvedBv) || solvedBv < 0 || solvedBv > bbbv ||
    !Number.isInteger(clicks) || clicks < 0 || clicks > 99_999
  ) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const session = await getSession().catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const day = Math.floor((now + 28800) / 86400); // +08:00 切天序号（与全站日聚合口径一致）
  const uid = session ? BigInt(session.uid) : BigInt(0); // 0=游客聚合行（BigInt 字面量本仓禁用）
  const wonInt = body.won ? 1 : 0;
  // 级别列自增量：beg/int/exp 计入各自列；cus 与未知级别只进 plays 总数（Prisma 模板参必须传表达式，逐分支写死）
  const begInc = level === "beg" ? 1 : 0;
  const intInc = level === "int" ? 1 : 0;
  const expInc = level === "exp" ? 1 : 0;
  // 完成盘数分级别（2026-11-06）：胜局按各自列自增（含 cus 专列，供活跃指数加权）
  const winBegInc = wonInt && level === "beg" ? 1 : 0;
  const winIntInc = wonInt && level === "int" ? 1 : 0;
  const winExpInc = wonInt && level === "exp" ? 1 : 0;
  const winCusInc = wonInt && level === "cus" ? 1 : 0;
  // 活跃点（2026-11-08）：服务端逐盘计点（口径单一来源 lib/actpoints.ts，
  // 与练习页客户端实时 +N 共用同一函数），败局也按 3BV 完成情况可能得分
  const pts = practiceActPoints(level, wonInt === 1, bbbv, solvedBv, ranked);
  // 分级别活跃点（2026-11-10 21:28 张老师定：活跃雷达初/中/高标签对齐活跃指数总分；
  // 自定义胜局与初级同权重进 ptsBeg——地区活跃指数同口径）
  const ptsBeg = level === "beg" || level === "cus" ? pts : 0;
  const ptsInt = level === "int" ? pts : 0;
  const ptsExp = level === "exp" ? pts : 0;
  // 原子 UPSERT：当日当用户无行则新建，有行则计数自增（并发局也安全）
  await prisma.$executeRaw`
    INSERT INTO practice_daily (day, user_id, plays, wins, plays_beg, plays_int, plays_exp,
      wins_beg, wins_int, wins_exp, wins_cus, act_points, pts_beg, pts_int, pts_exp,
      mode_ranked, mode_nf, mode_ng, mode_sq, mode_combo,
      sw_qmark, sw_stats, sw_sndfb, sw_shot, sw_qretry, sw_wheel, sw_pixel, create_time, update_time)
    VALUES (${day}, ${uid}, 1, ${wonInt}, ${begInc}, ${intInc}, ${expInc},
      ${winBegInc}, ${winIntInc}, ${winExpInc}, ${winCusInc}, ${pts}, ${ptsBeg}, ${ptsInt}, ${ptsExp},
      ${ranked ? 1 : 0}, ${nfOn ? 1 : 0}, ${ngOn ? 1 : 0}, ${sqOn ? 1 : 0}, ${comboOn ? 1 : 0},
      ${swQmark ? 1 : 0}, ${swStats ? 1 : 0}, ${swSndfb ? 1 : 0}, ${swShot ? 1 : 0}, ${swQretry ? 1 : 0}, ${swWheel ? 1 : 0}, ${swPixel ? 1 : 0}, ${now}, ${now})
    ON DUPLICATE KEY UPDATE
      plays = plays + 1,
      wins = wins + ${wonInt},
      plays_beg = plays_beg + ${begInc},
      plays_int = plays_int + ${intInc},
      plays_exp = plays_exp + ${expInc},
      wins_beg = wins_beg + ${winBegInc},
      wins_int = wins_int + ${winIntInc},
      wins_exp = wins_exp + ${winExpInc},
      wins_cus = wins_cus + ${winCusInc},
      act_points = act_points + ${pts},
      pts_beg = pts_beg + ${ptsBeg},
      pts_int = pts_int + ${ptsInt},
      pts_exp = pts_exp + ${ptsExp},
      mode_ranked = mode_ranked + ${ranked ? 1 : 0},
      mode_nf = mode_nf + ${nfOn ? 1 : 0},
      mode_ng = mode_ng + ${ngOn ? 1 : 0},
      mode_sq = mode_sq + ${sqOn ? 1 : 0},
      mode_combo = mode_combo + ${comboOn ? 1 : 0},
      sw_qmark = sw_qmark + ${swQmark ? 1 : 0},
      sw_stats = sw_stats + ${swStats ? 1 : 0},
      sw_sndfb = sw_sndfb + ${swSndfb ? 1 : 0},
      sw_shot = sw_shot + ${swShot ? 1 : 0},
      sw_qretry = sw_qretry + ${swQretry ? 1 : 0},
      sw_wheel = sw_wheel + ${swWheel ? 1 : 0},
      sw_pixel = sw_pixel + ${swPixel ? 1 : 0},
      update_time = ${now}
  `;
  // 小时分布桶（2026-10-27 /admin/practice 24h 图）：与主计数独立 UPSERT，
  // 失败静默 catch——小时图缺数据不影响 plays 主链路
  const hour = Math.floor((now + 28800) % 86400 / 3600);
  try {
    await prisma.$executeRaw`
      INSERT INTO practice_hourly (day, hour, plays, create_time, update_time)
      VALUES (${day}, ${hour}, 1, ${now}, ${now})
      ON DUPLICATE KEY UPDATE
        plays = plays + 1,
        update_time = ${now}
    `;
  } catch { /* ignore：小时分布缺一桶可接受 */ }
  // 排行延迟埋点（2026-10-28 张老师需求）：排行局带 rtt（客户端每秒 WS 探测的
  // 最近采样）时落一行 ranked_rtt_log。地区按请求方 IP 归属地统计（张老师 13:18 拍板，
  // 替代此前的 user.area 注册快照口径）——取 x-forwarded-for 真实客户端 IP，
  // ip2region 离线库解析省份，境外/内网/解析失败返回空串不落行。
  // 失败静默——延迟地图是增强数据，缺行可接受。
  if (ranked && session) {
    const rtt = Number(body.rtt);
    if (Number.isInteger(rtt) && rtt > 0 && rtt < 10_000) {
      try {
        const area = await ipToArea(getClientIp(req));
        if (area) {
          // 节点标识（2026-11-01）：客户端从 gameId 首段解析（a/b=北京双实例槽位，
          // hk/hz/cd=地域节点）；白名单粗校验——埋点数据不信任客户端，脏值宁可丢
          const regionRaw = String(body.region ?? "");
          const region = ["a", "b", "hk", "hz", "cd", "gz"].includes(regionRaw) ? regionRaw : "";
          await prisma.rankedRttLog.create({
            data: { userId: uid, area, region, rtt, createTime: BigInt(now) },
          });
        }
      } catch { /* ignore：延迟地图缺行可接受 */ }
    }
  }
  return NextResponse.json({ ok: true });
}
