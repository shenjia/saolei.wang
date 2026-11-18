// 粉丝/关注列表行（2026-11-18 张老师需求 4）：头像 + 姓名 + 性别 + 军衔（客户端懒加载
// 简化为姓名/性别/ID 气泡，与其他列表一致）+ 关注时间；行右端 hover 关注按钮
// （需求 1：本页头像也带 hover 关注钮，复用 AvatarFollowBtn + fol_wrap 容器）。
// 纯展示组件（服务端传行数据），翻页由页面 OldPager 承担。

import Link from "next/link";
import type { FollowListRow } from "@/lib/follow";
import { AvatarCell } from "./Cells";
import { DefaultAvatar } from "./DefaultAvatar";
import { AvatarImg } from "./AvatarImg";
import { AvatarFollowBtn } from "./AvatarFollowBtn";
import { formatDate } from "@/lib/format";
import { smallAvatarUrlFor } from "@/lib/small-avatar";

export function FollowListBody({
  rows,
  viewerId,
  followingIds,
}: {
  rows: FollowListRow[];
  /** 观看者 id（0=未登录）：本人行不渲染关注按钮 */
  viewerId: number;
  /** 观看者已关注的目标 id 集合（服务端批量查） */
  followingIds: number[];
}) {
  return (
    <table cellPadding={0} cellSpacing={0} className="table full fol_table">
      <tbody>
        {rows.map((r) => {
          const own = r.id === viewerId;
          const avatarUrl = r.avatar === "1" ? `/images/player/${r.id}.jpg` : r.avatar;
          const real =
            avatarUrl.startsWith("/uploads/avatar/") || avatarUrl.startsWith("http");
          return (
            <tr key={r.id}>
              <td className="fol_avatar_cell">
                <span className="fol_wrap">
                  <Link
                    className="fol_avatar_link"
                    href={`/user/${r.id}`}
                    target="_blank"
                    prefetch={false}
                    title={`进入 ${r.chineseName} 的地盘`}
                  >
                    {!avatarUrl || !real ? (
                      <DefaultAvatar sex={r.sex} size="small" className="fol_avatar" alt={r.chineseName} />
                    ) : (
                      <AvatarImg
                        src={smallAvatarUrlFor(avatarUrl, r.id) ?? avatarUrl}
                        fallback={avatarUrl}
                        className="fol_avatar"
                        alt={r.chineseName}
                      />
                    )}
                  </Link>
                  {!own && (
                    <AvatarFollowBtn
                      uid={r.id}
                      sex={r.sex}
                      loggedIn={viewerId > 0}
                      following={followingIds.includes(r.id)}
                    />
                  )}
                </span>
              </td>
              <td className="fol_name_cell">
                <AvatarCell
                  id={r.id}
                  name={r.chineseName}
                  englishName={r.englishName}
                  sex={r.sex}
                  gender="small"
                  link
                />
              </td>
              <td className="fol_time">{formatDate(r.createTime, "Y-m-d")}</td>
            </tr>
          );
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={3} className="text">
              还没有记录。
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
