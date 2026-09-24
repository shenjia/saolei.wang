// 录像紧凑行的共享渲染件（2026-09-24 从 VideoTable 抽出）：
// /video 列表（服务端整页）与首页「最新录像」版块（客户端「加载更多」）共用，
// 保证两处列定义/配色/字号完全一致。
// 本组件不含 <table> 骨架与数据获取，只负责表头与行；依赖仅限纯模块
// （lib/format / lib/config），可安全进入客户端 bundle。

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import { LEVEL_NAMES, type VideoLevel } from "@/lib/config";
import { score3bvs, scoreTime, videoScores, formatDate, timeOpposite, TIME_YEAR, isRecent } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";

// 2008 版级别配色（.Beg/.Int/.Exp + a.XXX 亮一档链接变体）
const LEVEL_CLS: Record<VideoLevel, string> = { beg: "lv_beg", int: "lv_int", exp: "lv_exp" };

/** 表头（列定义唯一来源，两处共用） */
export function VideoHead() {
  return (
    <thead>
      <tr>
        <th>上传者</th>
        <th>上传时间</th>
        <th>级别</th>
        <th>成绩</th>
        <th className="c">3BV</th>
        <th className="c">3BV/s</th>
        <th>评论 / 点击</th>
      </tr>
    </thead>
  );
}

/** 单行（<tr>），列宽/配色见 globals.css 的 .video_table */
export function VideoRowLine({ video: v }: { video: VideoListItem }) {
  const scores = videoScores(v.board3bv, v.realTime);
  const lvCls = LEVEL_CLS[v.level as VideoLevel] ?? "";
  return (
    <tr>
      <td className="name">
        {v.author ? (
          <>
            <AvatarCell id={v.author.id} name={v.author.chineseName} sex={v.author.sex} />
            <TitleBadge title={v.authorTitle} link />
          </>
        ) : (
          <span className="avatar_link">?</span>
        )}
      </td>
      <td
        className={`create_time ${isRecent(v.createTime) ? "time--recent" : "time--old"}`}
        title={formatDate(v.createTime, "Y年n月j日 H:i:s")}
      >
        {timeOpposite(v.createTime, TIME_YEAR, "Y-n-j")}
      </td>
      <td className={`level ${lvCls}`}>{LEVEL_NAMES[v.level as VideoLevel] ?? v.level}</td>
      <td className={`score ${lvCls}`}>
        <Link href={`/video/${v.id}`} target="_blank" title="点击查看录像">
          {scoreTime(scores.time)}
        </Link>
        {v.noflag && (
          <span className="nf" title="仅用左键点击完成游戏，全程不用右键标雷">
            NF
          </span>
        )}
      </td>
      <td className="c_3bvs bv c">{v.board3bv}</td>
      <td className="c_3bvs bvs c">
        {scores["3bvs"] > 0 ? (
          score3bvs(scores["3bvs"])
        ) : (
          <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">{score3bvs(-scores["3bvs"])}</del>
        )}
      </td>
      <td className="counters">
        <em>{v.comments}</em> / {v.clicks}
      </td>
    </tr>
  );
}
