// 用户组列表客户端壳（2026-10-27 张老师需求）
// · 新成员行加亮：以 localStorage 记录上次查看时刻，joinTime 晚于它的行加 new 类；
// · 进入列表即把查看时刻刷成「本次服务端组内最新加入时间」，并广播事件让侧栏 badge 消失；
// · 移出操作（2026-10-27 张老师定：低信任组每行都是「移出」，不再有「详情处理」跳转）：
//   可信组 → user.setTrusted false；低信任组 → LowTrustDialog（user.clearCheatPenalty，
//   弹窗里可选同时解除名下被屏蔽录像的屏蔽）。

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/Toast";
import { confirmDialog } from "@/components/Confirm";
import { postOp } from "./AdminAction";
import { LowTrustDialog } from "./LowTrustDialog";
import { formatDate } from "@/lib/format";
import type { GroupRow } from "@/lib/admin/usergroups";

const LS_KEY = "admin_group_seen_v1";

type SeenMap = Record<string, number>;

function readSeen(): SeenMap {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}") as SeenMap;
  } catch {
    return {};
  }
}

export function UserGroupTable({
  groupKey,
  rows,
  maxJoin,
  total,
  isAdmin,
}: {
  groupKey: "trusted" | "lowtrust";
  rows: GroupRow[];
  /** 服务端算好的组内最新加入时间（全量口径，0=组空/全部无法溯源） */
  maxJoin: number;
  /** 全组人数（与侧栏 badge 的 count 同口径，刷新基线用） */
  total: number;
  isAdmin: boolean;
}) {
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number>(0);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  // 首次挂载读到的旧基线（ref 守卫：React dev 严格模式 effect 双跑时，第二次读到
  // 的已是刷新后的基线，会把新行加亮吞掉——以第一次为准）
  const baseRef = useRef<number | null>(null);

  useEffect(() => {
    if (baseRef.current === null) {
      baseRef.current = readSeen()[groupKey] ?? 0;
    }
    setSeenAt(baseRef.current);
    // 挂载即记已读：基线刷成本次服务端给出的组内最新加入时刻 + 全组人数（badge 下次对比用），
    // 同时广播事件让侧栏 badge 即时消失
    const seen = readSeen();
    seen[groupKey] = Math.max(seen[groupKey] ?? 0, maxJoin);
    seen[groupKey + "_c"] = total;
    localStorage.setItem(LS_KEY, JSON.stringify(seen));
    window.dispatchEvent(new CustomEvent("admin-group-seen", { detail: { group: groupKey } }));
  }, [groupKey, maxJoin, total]);

  const remove = async (u: GroupRow) => {
    const ok = await confirmDialog({
      title: "操作确认",
      message: `确认把「${u.chineseName}」移出可信用户组？其后续上传录像将恢复 STNB 触发器检查，待审录像会立即重分拣。`,
      danger: true,
    });
    if (!ok) return;
    setBusyId(u.id);
    const res = await postOp("user.setTrusted", { id: u.id, trusted: false });
    setBusyId(0);
    if (res.ok) {
      toast(res.message ?? "操作成功", "success");
      setRemoved((s) => new Set(s).add(u.id));
    } else {
      toast(res.error ?? "操作失败", "error");
    }
  };

  const visible = rows.filter((r) => !removed.has(r.id));

  return (
    <div className="admin_scroll">
      <table className="admin_table">
        <thead>
          <tr>
            <th className="c">ID</th>
            <th>玩家</th>
            {groupKey === "lowtrust" && <th>来源</th>}
            <th>加入时间</th>
            <th>操作管理员</th>
            {groupKey === "lowtrust" && <th>标记到期</th>}
            <th>账号状态</th>
            <th className="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((u) => {
            const isNew = seenAt !== null && (u.joinTime ?? 0) > seenAt;
            return (
              <tr key={u.id} className={isNew ? "ug_new" : undefined}>
                <td className="c sub">{u.id}</td>
                <td>
                  <Link className="link" href={`/admin/users/${u.id}`}>
                    {u.chineseName}
                  </Link>
                </td>
                {groupKey === "lowtrust" && (
                  <td>
                    {u.sources.map((s) => (
                      <span
                        key={s}
                        className={`admin_tag ${s === "反作弊标记" ? "bad" : "plain"}`}
                        style={{ marginRight: 4 }}
                      >
                        {s}
                      </span>
                    ))}
                  </td>
                )}
                <td className="sub">{u.joinTime ? formatDate(u.joinTime, "Y-m-d H:i") : <span title="建组前的历史记录，无法溯源">早于 10-27</span>}</td>
                <td className="sub">{u.joinBy ?? "—"}</td>
                {groupKey === "lowtrust" && (
                  <td className="sub">
                    {u.lowTrustUntil > 0 ? formatDate(u.lowTrustUntil, "Y-m-d H:i") : "—"}
                    {u.blockedCount > 0 && (
                      <span className="admin_tag plain" style={{ marginLeft: 4 }} title="名下已屏蔽的录像（不勾选「同时解除屏蔽」则保持屏蔽）">
                        屏蔽 {u.blockedCount} 部
                      </span>
                    )}
                  </td>
                )}
                <td className="c">
                  {u.status === 0 ? (
                    <span className="admin_tag ok">正常</span>
                  ) : (
                    <span className="admin_tag bad">已封禁</span>
                  )}
                </td>
                <td className="ops">
                  {groupKey === "trusted" ? (
                    isAdmin ? (
                      <button
                        type="button"
                        className="admin_btn sm"
                        disabled={busyId === u.id}
                        onClick={() => remove(u)}
                      >
                        {busyId === u.id ? "…" : "移出用户组"}
                      </button>
                    ) : (
                      <span className="sub">仅超管</span>
                    )
                  ) : isAdmin ? (
                    <LowTrustDialog
                      userId={u.id}
                      name={u.chineseName}
                      blockedCount={u.blockedCount}
                      onDone={(ok) => {
                        if (ok) setRemoved((s) => new Set(s).add(u.id));
                      }}
                    />
                  ) : (
                    <span className="sub">仅超管</span>
                  )}
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={groupKey === "lowtrust" ? 8 : 6}>
                <div className="admin_empty">当前没有组内成员</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
