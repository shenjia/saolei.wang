// 管理后台 · 比赛详情（2026-11-13 四期 张老师需求）
// 清单点比赛全名进入：上半比赛基本信息，下半录像列表 + 玩家列表（各自分页）。
// 录像列：ID/玩家/级别/time/3BV/s/3BV/审核状态/播放/上传时间/操作（移出比赛）。
// 玩家列：ID/人名/军衔/录像数/当前成绩——成绩按比赛配置的计算方式算（越小越好），
//         玩家=有录像挂在本比赛的人（含屏蔽录像的拥有者，成绩只认有效录像）。
// 移出比赛复用 video.competition op（competitionId=0 解除挂接）。

import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@/lib/db";
import {
  compStatus,
  computePlayerScores,
  fmtScoreMs,
  parsePrizePlan,
  parseScoreConfig,
  scoreModeDesc,
} from "@/lib/competition";
import { dualTitles } from "@/lib/title-system";
import { LEVELS, LEVEL_NAMES, type Level } from "@/lib/config";
import { scoreTime } from "@/lib/format";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminCard, AdminPager, LevelTag, StatusTag } from "@/components/admin/Widgets";
import { AvatarCell, TitleBadge } from "@/components/Cells";

export const dynamic = "force-dynamic";
export const metadata = { title: "比赛详情 | 管理后台" };

type StatusKey = ReturnType<typeof compStatus>;

/** Unix 秒 → 北京时间 "YYYY-MM-DD HH:mm"（同清单页） */
function cstStr(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const STATUS_LABEL = { active: "进行中", upcoming: "未开始", ended: "已结束" } as const;
const STATUS_COLOR = { active: "#a6e22e", upcoming: "#fdc61a", ended: "#939387" } as const;

const PAGE_SIZE = 20;

export default async function AdminCompetitionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id: idStr } = await params;
  const sp = await searchParams;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <div className="admin_page_head">
        <h1>比赛详情</h1>
        <p className="admin_note">无效的比赛 ID</p>
      </div>
    );
  }

  const comp = await prisma.competition.findUnique({ where: { id: BigInt(id) } });
  if (!comp) {
    return (
      <div className="admin_page_head">
        <h1>比赛详情</h1>
        <p className="admin_note">
          比赛 #{id} 不存在 · <Link className="link" href="/admin/competitions">返回清单</Link>
        </p>
      </div>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const stKey = compStatus(comp.startTime, comp.endTime, now);

  // 本比赛全部挂接录像（含屏蔽，后台看全貌）+ 成绩字段分表取（Video/VideoInfo 无 relation）
  const [allVideos, entryCount] = await Promise.all([
    prisma.video.findMany({
      where: { competitionId: BigInt(id) },
      select: { id: true, user: true, level: true, status: true, createTime: true },
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
    }),
    prisma.competitionEntry.count({ where: { competitionId: BigInt(id) } }),
  ]);
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: allVideos.map((v) => v.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));

  // 玩家集合 = 有录像挂在本比赛的 distinct user（报名未传录像的不在此列）
  const uids = [...new Set(allVideos.map((v) => v.user))];
  const users = uids.length
    ? await prisma.user.findMany({
        where: { id: { in: uids } },
        select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [Number(u.id), u]));
  // 军衔（与前台玩家卡片同口径：user_scores.exp_time 现评，阈值单次取）
  const scores = uids.length
    ? await prisma.userScores.findMany({
        where: { id: { in: uids } },
        select: { id: true, expTime: true },
      })
    : [];
  const expMap = new Map(scores.map((s) => [Number(s.id), s.expTime ?? 0]));
  const rankedMap = new Map(users.map((u) => [Number(u.id), u.status === 0]));
  const titlePairs = await dualTitles(
    uids.map((u) => ({
      userId: Number(u),
      expTime: expMap.get(Number(u)) ?? 0,
      ranked: rankedMap.get(Number(u)) ?? false,
      sex: userMap.get(Number(u))?.sex ?? 1,
    }))
  );
  const titleMap = new Map(uids.map((u, i) => [Number(u), titlePairs[i]]));

  // 玩家成绩：只认未屏蔽录像（computePlayerScores 内部再滤 real_time/no_record）
  const scoreMap = computePlayerScores(
    comp.scoreMode,
    comp.scoreConfig,
    allVideos
      .filter((v) => v.status !== 0)
      .map((v) => ({
        user: v.user,
        level: v.level,
        realTime: infoMap.get(v.id)?.realTime ?? 0,
        noRecord: infoMap.get(v.id)?.noRecord ?? false,
      })),
  );

  // 玩家列表：有成绩在前（越小越好），无成绩按 UID 排后；内存切页（比赛规模小）
  const playerRows = [...uids.map(Number)]
    .map((uid) => ({
      uid,
      name: userMap.get(uid)?.chineseName ?? `#${uid}`,
      englishName: userMap.get(uid)?.englishName ?? "",
      sex: userMap.get(uid)?.sex ?? 1,
      title: titleMap.get(uid)?.m ?? "",
      classic: titleMap.get(uid)?.c ?? null,
      videoCount: allVideos.filter((v) => Number(v.user) === uid).length,
      score: scoreMap.get(uid),
    }))
    .sort((a, b) => {
      if (a.score != null && b.score != null) return a.score - b.score;
      if (a.score != null) return -1;
      if (b.score != null) return 1;
      return a.uid - b.uid;
    });

  // 分页（录像/玩家各自页码，URL pv/pp 承载）
  const videoTotal = allVideos.length;
  const videoPages = Math.max(1, Math.ceil(videoTotal / PAGE_SIZE));
  const pv = Math.min(Math.max(Number(sp.pv) || 1, 1), videoPages);
  const videoRows = allVideos.slice((pv - 1) * PAGE_SIZE, pv * PAGE_SIZE);

  const playerTotal = playerRows.length;
  const playerPages = Math.max(1, Math.ceil(playerTotal / PAGE_SIZE));
  const pp = Math.min(Math.max(Number(sp.pp) || 1, 1), playerPages);
  const playerPageRows = playerRows.slice((pp - 1) * PAGE_SIZE, pp * PAGE_SIZE);

  const levelSet = new Set(
    comp.includeLevels
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Level => (LEVELS as readonly string[]).includes(s)),
  );
  const levels = levelSet.size ? LEVELS.filter((l) => levelSet.has(l)) : [...LEVELS];

  const info = (label: string, node: ReactNode) => (
    <tr key={label}>
      <th style={{ width: 120, textAlign: "right", whiteSpace: "nowrap" }}>{label}</th>
      <td>{node}</td>
    </tr>
  );

  return (
    <>
      <div className="admin_page_head">
        <h1>
          <Link className="link" href="/admin/competitions">比赛管理</Link>
          {" / "}
          {comp.name}
        </h1>
        <span className="sub">
          #{comp.id} ·{" "}
          <a href={`/competitions/${comp.id}`} target="_blank" rel="noopener noreferrer">
            前台详情页
          </a>
        </span>
      </div>

      <AdminCard title="基本信息" tight>
        <table className="admin_table">
          <tbody>
            {info(
              "比赛名称",
              <>
                {comp.name}
                <span style={{ color: STATUS_COLOR[stKey] }}>（{STATUS_LABEL[stKey]}）</span>
              </>,
            )}
            {info("简称", comp.shortName)}
            {info("比赛标识", <span className="mono">{comp.code || "—"}</span>)}
            {info("起止时间", `${cstStr(Number(comp.startTime))} ~ ${cstStr(Number(comp.endTime))}（北京）`)}
            {info("收录级别", levels.map((l) => LEVEL_NAMES[l]).join("、"))}
            {info("成绩计算方式", scoreModeDesc(comp.scoreMode, comp.scoreConfig))}
            {info("总奖金", <span style={{ color: "#fdc61a" }}>¥{comp.prizeTotal.toLocaleString("en-US")}</span>)}
            {info(
              "分配方案",
              parsePrizePlan(comp.prizePlan).length ? (
                <span style={{ whiteSpace: "pre-line" }}>{parsePrizePlan(comp.prizePlan).join("\n")}</span>
              ) : (
                "—"
              ),
            )}
            {info("比赛规则", <span style={{ whiteSpace: "pre-line" }}>{comp.rules}</span>)}
            {info(
              "统计",
              <>
                录像 {videoTotal} 条 · 有成绩玩家 {scoreMap.size} 人 · 报名 {entryCount} 人
              </>,
            )}
          </tbody>
        </table>
      </AdminCard>

      <AdminCard title="录像列表" tight>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>玩家</th>
                <th className="c">级别</th>
                <th className="num">time</th>
                <th className="num">3BV/s</th>
                <th className="num">3BV</th>
                <th className="c">审核状态</th>
                <th className="c">播放</th>
                <th>上传时间</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {videoRows.map((v) => {
                const inf = infoMap.get(v.id);
                const rt = inf?.realTime ?? 0;
                const b3 = inf?.board3bv ?? 0;
                const b3vs = rt > 0 && !inf?.noRecord ? Math.round((b3 * 1e6) / rt) : 0;
                return (
                  <tr key={v.id.toString()} className={v.status === 0 ? "off" : undefined}>
                    <td className="c sub">{v.id.toString()}</td>
                    <td className="player">
                      <AvatarCell
                        id={Number(v.user)}
                        name={userMap.get(Number(v.user))?.chineseName ?? `#${v.user}`}
                        englishName={userMap.get(Number(v.user))?.englishName ?? ""}
                        sex={userMap.get(Number(v.user))?.sex ?? 1}
                        gender="small"
                      />
                    </td>
                    <td className="c">
                      <LevelTag level={v.level} />
                    </td>
                    <td className="num strong">{rt > 0 && !inf?.noRecord ? scoreTime(rt) : "—"}</td>
                    <td className="num">{b3vs > 0 ? (b3vs / 1000).toFixed(3) : "—"}</td>
                    <td className="num">{inf?.noRecord ? "—" : b3 || "—"}</td>
                    <td className="c">
                      <StatusTag status={v.status} />
                    </td>
                    <td className="c">
                      <Link
                        className="link"
                        href={`/video/${v.id}`}
                        target="_blank"
                        prefetch={false}
                        title="新标签页打开前台录像详情页"
                      >
                        播放
                      </Link>
                    </td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {cstStr(Number(v.createTime))}
                    </td>
                    <td className="ops">
                      <AdminAction
                        op="video.competition"
                        params={{ id: v.id.toString(), competitionId: 0 }}
                        label="移出比赛"
                        confirm={`确认将录像 #${v.id} 移出本场比赛？`}
                      />
                    </td>
                  </tr>
                );
              })}
              {videoRows.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <div className="admin_empty">本比赛还没有收录录像（清单行「收录像」或录像管理「挂接比赛」均可）</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {videoTotal > 0 && (
          <AdminPager base={`/admin/competitions/${id}`} params={sp} page={pv} total={videoTotal} pageSize={PAGE_SIZE} />
        )}
      </AdminCard>

      <AdminCard title="玩家列表" tight>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>人名</th>
                <th>军衔</th>
                <th className="c">录像数</th>
                <th className="num">当前成绩</th>
              </tr>
            </thead>
            <tbody>
              {playerPageRows.map((p) => (
                <tr key={p.uid}>
                  <td className="c sub">{p.uid}</td>
                  <td className="player">
                    <AvatarCell id={p.uid} name={p.name} englishName={p.englishName} sex={p.sex} gender="small" />
                  </td>
                  <td>
                    <TitleBadge title={p.title} classic={p.classic} />
                  </td>
                  <td className="c">{p.videoCount}</td>
                  <td className="num strong">
                    {p.score != null ? (
                      fmtScoreMs(p.score)
                    ) : (
                      <span style={{ color: "#939387" }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
              {playerPageRows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="admin_empty">还没有玩家录像</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {playerTotal > 0 && (
          <AdminPager base={`/admin/competitions/${id}`} params={sp} page={pp} total={playerTotal} pageSize={PAGE_SIZE} />
        )}
        {comp.scoreMode && (
          <div className="admin_note" style={{ marginTop: 8 }}>
            成绩口径：{scoreModeDesc(comp.scoreMode, comp.scoreConfig)}——只认未屏蔽、非运气盘录像，越小越好。
          </div>
        )}
      </AdminCard>
    </>
  );
}
