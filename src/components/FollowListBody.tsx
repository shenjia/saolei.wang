// 关注/粉丝列表行（2026-11-18 需求 4，23:42 张老师五改）：
// 表头「姓名、军衔、关注时间、操作」四列；姓名列=头像+姓名+性别（军衔徽章紧随其后，
// 与姓名列同单元格呈跟随形态）；操作列=关注按钮（显示逻辑同头像 hover 钮：
// 已关注亮灰/hover 变红取消，未关注绿）。取消关注后行实时消失（客户端就地移除）。
// 关注时间=「XXX关注」相对时间（hover 气泡绝对时间到秒，1 年以上显式精确到分钟）。
// 标题（共XX人）下标由页面 h1 渲染（FollowListFeed 传 total）。

import Link from "next/link";
import { useState } from "react";
import type { FollowListRow } from "@/lib/follow";
import { DefaultAvatar } from "./DefaultAvatar";
import { AvatarImg } from "./AvatarImg";
import { TitleBadge } from "./TitleBadge";
import { RelTime } from "./RelTime";
import { toast } from "./Toast";
import { TIME_YEAR } from "@/lib/format";
import { smallAvatarUrlFor } from "@/lib/small-avatar";

export function FollowListBody({
  rows,
  viewerId,
  followingIds,
}: {
  rows: FollowListRow[];
  /** 观看者 id（0=未登录）：本人行操作列不渲染按钮 */
  viewerId: number;
  /** 观看者已关注的目标 id 集合（服务端批量查/翻页补查） */
  followingIds: number[];
}) {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  // 取消关注实时消失（23:42 张老师定）：FollowOpBtn 取消成功回调，行就地移除
  const visible = rows.filter((r) => !hidden.has(r.id));
  return (
    <table cellPadding={0} cellSpacing={0} className="table full fol_table">
      <thead>
        <tr>
          <th>姓名</th>
          <th>军衔</th>
          <th>关注时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((r) => (
          <FollowRow
            key={r.id}
            row={r}
            viewerId={viewerId}
            followingIds={followingIds}
            onRemoved={() => setHidden((prev) => new Set(prev).add(r.id))}
          />
        ))}
        {visible.length === 0 && (
          <tr>
            <td colSpan={4} className="text">
              还没有记录。
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function FollowRow({
  row,
  viewerId,
  followingIds,
  onRemoved,
}: {
  row: FollowListRow;
  viewerId: number;
  followingIds: number[];
  onRemoved: () => void;
}) {
  const own = row.id === viewerId;
  const avatarUrl = row.avatar === "1" ? `/images/player/${row.id}.jpg` : row.avatar;
  const real = avatarUrl.startsWith("/uploads/avatar/") || avatarUrl.startsWith("http");
  return (
    <tr>
      {/* 姓名列：头像+姓名+性别+军衔徽章（性别标记后，23:42 张老师定跟随形态） */}
      <td className="fol_name_cell">
        <span className="fol_wrap fol_inline_wrap">
          <Link
            className="fol_avatar_link"
            href={`/user/${row.id}`}
            target="_blank"
            prefetch={false}
            title={`进入 ${row.chineseName} 的地盘`}
          >
            {!avatarUrl || !real ? (
              <DefaultAvatar sex={row.sex} size="small" className="fol_avatar" alt={row.chineseName} />
            ) : (
              <AvatarImg
                src={smallAvatarUrlFor(avatarUrl, row.id) ?? avatarUrl}
                fallback={avatarUrl}
                className="fol_avatar"
                alt={row.chineseName}
              />
            )}
          </Link>
          <Link className="avatar_link fol_name" href={`/user/${row.id}`} target="_blank" prefetch={false}>
            {row.chineseName}
          </Link>
          <span className={`gender ${row.sex ? "male" : "female"} small`}></span>
          <TitleBadge title={row.title} classic={row.classic} link />
        </span>
      </td>
      {/* 军衔列：徽章独立呈现（跟随形态的备选口径——两处同源同徽章，列宽保证表头语义） */}
      <td className="fol_title_cell">
        <TitleBadge title={row.title} classic={row.classic} link />
      </td>
      {/* 关注时间：相对时间（hover 气泡绝对时间到秒），1 年以上显式精确到分钟 */}
      <td className="fol_time">
        <RelTime time={row.createTime} max={TIME_YEAR} format="Y-n-j H:i" />
      </td>
      {/* 操作列：关注按钮（逻辑同头像 hover 钮；本人行不渲染） */}
      <td className="fol_op_cell">
        {!own && (
          <FollowOpBtn
            uid={row.id}
            sex={row.sex}
            loggedIn={viewerId > 0}
            following={followingIds.includes(row.id)}
            onRemoved={onRemoved}
          />
        )}
      </td>
    </tr>
  );
}

/** 操作列按钮：AvatarFollowBtn 同逻辑，取消成功后回调 onRemoved 让行实时消失 */
function FollowOpBtn({
  uid,
  sex,
  loggedIn,
  following,
  onRemoved,
}: {
  uid: number;
  sex: number;
  loggedIn: boolean;
  following: boolean;
  onRemoved: () => void;
}) {
  const [isFol, setIsFol] = useState(following);
  const [busy, setBusy] = useState(false);
  async function act() {
    if (busy) return;
    if (!loggedIn) {
      toast("请先登录后再关注", "info");
      return;
    }
    setBusy(true);
    const next = !isFol;
    try {
      const res = await fetch("/api/follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: next ? "follow" : "unfollow", uid }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast(data.error ?? "操作失败，请重试", "error");
        return;
      }
      if (!next) {
        toast("已取消关注", "success");
        onRemoved();
        return;
      }
      setIsFol(true);
      toast("关注成功", "success");
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className={`fol_btn fol_op_btn${isFol ? " is_fol" : ""}`}
      disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void act();
      }}
    >
      {isFol ? "取消关注" : sex ? "+关注他" : "+关注她"}
    </button>
  );
}
