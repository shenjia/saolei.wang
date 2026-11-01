// 账户合并弹窗（2026-11-01 张老师需求）
// 把当前账户全部数据（录像/成绩/文章/评论/动态/站内信/绑定等）并入目标账户后注销源账户。
// 不可逆重操作：弹窗要求填写目标玩家 ID，确认文案回显双方 ID 与名字供核对。
// 业务规则（服务端 ops.ts user.merge）：源=管理员账号拒绝、目标=封禁/无凭据拒绝、
// 成绩六池取优合并、源行清零防双计、名次/STNB/纪录链/录像计数按口径重算。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { confirmDialog } from "@/components/Confirm";

export function MergeUserDialog({
  userId,
  name,
  sm = true,
}: {
  userId: number;
  name: string;
  sm?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const tid = parseInt(targetId.trim(), 10);
    if (!Number.isInteger(tid) || tid <= 0) {
      toast("请填写有效的目标玩家 ID");
      return;
    }
    if (tid === userId) {
      toast("目标账户不能是当前账户自己");
      return;
    }
    if (
      !(await confirmMerge(
        `⚠️ 不可逆操作：确认把「${name}」（#${userId}）的全部数据（录像、成绩、文章、评论、动态、站内信、第三方与邮箱绑定等）` +
          `合并到玩家 #${tid} 名下，随后注销「${name}」的账号？合并后源账户无法登录、无法恢复。`
      ))
    ) {
      return;
    }
    setBusy(true);
    const res = await postOp("user.merge", { id: userId, targetId: tid });
    setBusy(false);
    toast(res.ok ? res.message ?? "已合并" : res.error ?? "操作失败", res.ok ? "success" : "error");
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  };

  const confirmMerge = async (message: string): Promise<boolean> =>
    confirmDialog({ title: "操作确认", message, danger: true });

  return (
    <>
      <button type="button" className={`admin_btn danger${sm ? " sm" : ""}`} onClick={() => setOpen(true)}>
        账户合并
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>账户合并</h1>
            <p className="ban_desc">
              玩家「{name}」（#{userId}）的全部数据将并入目标账户，随后本账户注销（无法登录、不可恢复）。
            </p>

            <div className="ban_label">目标玩家 ID</div>
            <input
              className="admin_input"
              type="number"
              placeholder="填写接收数据的玩家 ID"
              value={targetId}
              disabled={busy}
              onChange={(e) => setTargetId(e.target.value)}
              style={{ width: "100%" }}
            />

            <p className="ban_hint">
              搬迁范围：录像与成绩榜、评论、论坛主题/回复、动态、站内信、QQ/微信绑定、邮箱绑定（目标未绑时随迁）、
              赞助记录、每日一星、扫雷历程、地盘人气。
              成绩按双方最优合并（源行清零防双计），名次 / STNB 榜 / 纪录动态 / 录像计数自动重算；
              反作弊标记与后台审计记录不随迁。
            </p>

            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn danger" disabled={busy} onClick={submit}>
                {busy ? "处理中…" : "确认合并"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
