// 编辑玩家资料弹窗（2026-11-02 张老师需求：处置区提供「编辑资料」按钮，点击弹出浮层编辑，
// 不把表单直接铺在处置区）。覆盖玩家填写的全部资料：
// 中文名/英文名/性别/地区（user 表）+ 昵称/QQ/鼠标/鼠标垫/爱好/生日（user_info 表）。
// 业务校验在服务端 ops.ts user.editProfile（姓名与注册同规、文本上限与前台编辑资料同口径、
// 地区变化同事务搬 user_rank 名次），弹窗只做必填提示；变更摘要由服务端返回并记 admin_log。

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import { AREA_LIST } from "@/lib/config";
import { formatDate } from "@/lib/format";

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const labelStyle: React.CSSProperties = { fontSize: 13, color: "#c2c2b8" };

export function EditProfileDialog({
  userId,
  name,
  chineseName: initZh,
  englishName: initEn,
  sex: initSex,
  area: initArea,
  nickname: initNickname,
  qq: initQq,
  mouse: initMouse,
  pad: initPad,
  interest: initInterest,
  birthday: initBirthday,
  sm = true,
}: {
  userId: number;
  name: string;
  /** 当前资料（打开弹窗时作为表单初值） */
  chineseName: string;
  englishName: string;
  sex: number;
  area: string;
  nickname: string;
  qq: string;
  mouse: string;
  pad: string;
  interest: string;
  /** 生日（Unix 秒，0=未填写） */
  birthday: number;
  sm?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    chineseName: initZh,
    englishName: initEn,
    sex: String(initSex),
    area: initArea,
    nickname: initNickname,
    qq: initQq,
    mouse: initMouse,
    pad: initPad,
    interest: initInterest,
    birthday: initBirthday ? formatDate(initBirthday, "Y-m-d") : "",
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((p) => ({ ...p, [k]: e.target.value }));

  const openDialog = () => {
    // 每次打开按当下资料重置（router.refresh 后 props 已是新值）
    setV({
      chineseName: initZh,
      englishName: initEn,
      sex: String(initSex),
      area: initArea,
      nickname: initNickname,
      qq: initQq,
      mouse: initMouse,
      pad: initPad,
      interest: initInterest,
      birthday: initBirthday ? formatDate(initBirthday, "Y-m-d") : "",
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!v.chineseName.trim() || !v.englishName.trim()) {
      toast("中文名与英文名（姓名拼音）必填");
      return;
    }
    setBusy(true);
    const res = await postOp("user.editProfile", { id: userId, ...v });
    setBusy(false);
    toast(res.ok ? res.message ?? "已保存" : res.error ?? "保存失败", res.ok ? "success" : "error");
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  };

  // 地区下拉：历史遗留「xx&xx」等不在白名单的现值保留为「保持现状」选项
  const areaOptions: [string, string][] = (AREA_LIST as readonly string[]).includes(initArea)
    ? AREA_LIST.map((a) => [a, a] as [string, string])
    : [[initArea, `${initArea}（保持现状）`], ...AREA_LIST.map((a) => [a, a] as [string, string])];

  const text = (k: keyof typeof v, label: string, placeholder?: string, type = "text") => (
    <label style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <input className="admin_input" type={type} placeholder={placeholder} value={v[k]} disabled={busy} onChange={set(k)} style={{ width: "100%" }} />
    </label>
  );

  const select = (k: keyof typeof v, label: string, options: [string, string][]) => (
    <label style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <select className="admin_select" value={v[k]} disabled={busy} onChange={set(k)} style={{ width: "100%" }}>
        {options.map(([val, lab]) => (
          <option key={val} value={val}>
            {lab}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <button type="button" className={`admin_btn${sm ? " sm" : ""}`} onClick={openDialog}>
        编辑资料
      </button>
      {open && (
        <div className="ban_overlay" onClick={() => !busy && setOpen(false)}>
          <div
            className="ban_dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 560, maxHeight: "calc(100vh - 60px)", overflowY: "auto" }}
          >
            <h1>编辑玩家资料</h1>
            <p className="ban_desc">
              玩家「{name}」（#{userId}）填写的资料。保存后立即生效并记入后台操作日志；拼音词数须与姓名字数一致（如「陈一宁」= Chen Yi Ning）。
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px", marginBottom: 14 }}>
              {text("chineseName", "中文名")}
              {text("englishName", "英文名（姓名拼音）", "如 Chen Yi Ning")}
              {select(
                "sex",
                "性别",
                [
                  ["1", "男"],
                  ["0", "女"],
                ]
              )}
              {select("area", "地区", areaOptions)}
              {text("nickname", "昵称")}
              {text("qq", "QQ")}
              {text("mouse", "鼠标")}
              {text("pad", "鼠标垫")}
            </div>
            <div style={{ display: "grid", gap: 12, marginBottom: 6 }}>
              {text("interest", "爱好")}
              {text("birthday", "生日（留空=不修改）", undefined, "date")}
            </div>

            <p className="ban_hint" style={{ marginLeft: 0, marginBottom: 16 }}>
              生日留空提交视为不修改；地区改动会同步搬动地区榜名次位次（口径同前台改资料）。
            </p>

            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="admin_btn primary" disabled={busy} onClick={submit}>
                {busy ? "保存中…" : "保存资料"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
