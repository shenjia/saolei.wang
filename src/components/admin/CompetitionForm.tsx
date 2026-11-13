"use client";

// 比赛发起/编辑表单（2026-11-13 后台「比赛管理」页）
// 字段：比赛全名 / 简称（3-4字）/ 起止时间（datetime-local，北京时间）/ 比赛规则 /
//       发起人 ID / 总奖金（元）/ 分配方案（每行一名次，如「第一名 ¥600」）。
// 提交走统一 /api/admin/action（competition.add / competition.edit）。
// 编辑模式：清单行「编辑」按钮派发 sl-comp-edit 事件回填，可取消。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";

export interface CompFormRow {
  id: number;
  name: string;
  shortName: string;
  startTime: string; // "YYYY-MM-DD HH:mm"
  endTime: string;
  rules: string;
  creatorId: number;
  prizeTotal: number;
  prizePlan: string;
  levels: string[]; // 收录录像级别（beg/int/exp 子集）
  scoreMode: string; // ""=未配置 / sum_topn / target_diff
  scoreConf: Record<string, number> | null; // 解析后的计算参数（未配置 null）
}

/** 库里 Unix 秒 → datetime-local input 值（北京时间 YYYY-MM-DDTHH:mm） */
function cstInput(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const EMPTY = { name: "", shortName: "", startTime: "", endTime: "", rules: "", creatorId: "", prizeTotal: "", prizePlan: "" };
const ALL_LEVELS = ["beg", "int", "exp"] as const;
const LEVEL_LABELS: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };

export function CompetitionForm() {
  const router = useRouter();
  const [values, setValues] = useState({ ...EMPTY });
  // 收录录像级别（张老师 2026-11-13：可多选，默认初中高都有）
  const [levels, setLevels] = useState<string[]>([...ALL_LEVELS]);
  // 成绩计算方式（张老师 2026-11-13 四期：创建/编辑时配置，后续可扩更多方式）
  const [scoreMode, setScoreMode] = useState("");
  const [topn, setTopn] = useState({ beg: "1", int: "1", exp: "1" });
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<CompFormRow | null>(null);

  const set = (k: keyof typeof EMPTY, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const toggleLevel = (lv: string) =>
    setLevels((s) => {
      const next = s.includes(lv) ? s.filter((x) => x !== lv) : [...s, lv];
      return ALL_LEVELS.filter((a) => next.includes(a)); // 恒按初中高顺序存放
    });

  // 监听清单行「编辑」：回填记录
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent).detail as CompFormRow & { startSec: number; endSec: number };
      if (!d || typeof d.id !== "number") return;
      setEditing(d);
      setValues({
        name: d.name,
        shortName: d.shortName,
        startTime: cstInput(d.startSec),
        endTime: cstInput(d.endSec),
        rules: d.rules,
        creatorId: String(d.creatorId),
        prizeTotal: String(d.prizeTotal),
        prizePlan: d.prizePlan,
      });
      setLevels(d.levels.length ? [...ALL_LEVELS].filter((a) => d.levels.includes(a)) : [...ALL_LEVELS]);
      setScoreMode(d.scoreMode ?? "");
      setTopn({
        beg: String(d.scoreConf?.beg ?? 1),
        int: String(d.scoreConf?.int ?? 1),
        exp: String(d.scoreConf?.exp ?? 1),
      });
      setTarget(d.scoreConf?.target != null ? String(d.scoreConf.target) : "");
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("sl-comp-edit", onEdit);
    return () => window.removeEventListener("sl-comp-edit", onEdit);
  }, []);

  const reset = () => {
    setEditing(null);
    setValues({ ...EMPTY });
    setLevels([...ALL_LEVELS]);
    setScoreMode("");
    setTopn({ beg: "1", int: "1", exp: "1" });
    setTarget("");
  };

  const submit = async () => {
    if (!values.name.trim()) return toast("请填写比赛全名", "error");
    if (!values.shortName.trim()) return toast("请填写比赛简称（3-4 字）", "error");
    if (!values.startTime || !values.endTime) return toast("请填写起止时间", "error");
    if (values.endTime <= values.startTime) return toast("结束时间必须晚于开始时间", "error");
    if (!values.rules.trim()) return toast("请填写比赛规则", "error");
    if (!/^\d+$/.test(values.creatorId.trim())) return toast("请填写发起人 ID（纯数字 UID）", "error");
    if (!/^\d+$/.test(values.prizeTotal.trim())) return toast("总奖金应为非负整数（元）", "error");
    if (levels.length === 0) return toast("请至少勾选一个收录录像级别", "error");
    // 成绩计算方式参数校验（null=配置非法，""=未配置）
    let scoreConfig = "";
    if (scoreMode === "sum_topn") {
      const conf: Record<string, number> = {};
      let any = false;
      for (const lv of ALL_LEVELS) {
        const v = topn[lv].trim();
        if (!/^\d+$/.test(v) || parseInt(v, 10) > 99) return toast(`${LEVEL_LABELS[lv]}取局数应为 0-99 整数`, "error");
        conf[lv] = parseInt(v, 10);
        if (conf[lv] > 0) any = true;
      }
      if (!any) return toast("成绩加总至少有一个级别取局数大于 0", "error");
      scoreConfig = JSON.stringify(conf);
    } else if (scoreMode === "target_diff") {
      const n = Number(target.trim());
      if (!target.trim() || !Number.isFinite(n) || n <= 0) return toast("目标成绩应为正数（秒，如 8.88）", "error");
      scoreConfig = JSON.stringify({ target: n });
    }

    setBusy(true);
    try {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing
            ? {
                op: "competition.edit",
                id: editing.id,
                name: values.name,
                shortName: values.shortName,
                startTime: values.startTime.replace("T", " "),
                endTime: values.endTime.replace("T", " "),
                rules: values.rules,
                creatorId: values.creatorId,
                prizeTotal: values.prizeTotal,
                prizePlan: values.prizePlan,
                levels,
                scoreMode,
                scoreConfig,
              }
            : {
                op: "competition.add",
                name: values.name,
                shortName: values.shortName,
                startTime: values.startTime.replace("T", " "),
                endTime: values.endTime.replace("T", " "),
                rules: values.rules,
                creatorId: values.creatorId,
                prizeTotal: values.prizeTotal,
                prizePlan: values.prizePlan,
                levels,
                scoreMode,
                scoreConfig,
              }
        ),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      toast(data.ok ? data.message ?? "操作成功" : data.error ?? "操作失败", data.ok ? "success" : "error");
      if (data.ok) {
        reset();
        router.refresh();
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setBusy(false);
    }
  };

  const labelStyle = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#939387" } as const;
  const twoCol = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 } as const;

  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void submit();
      }}
    >
      {editing && (
        <div style={{ color: "#e6b422", fontSize: 13 }}>
          正在编辑比赛 #{editing.id}（{editing.name}）{" "}
          <button type="button" className="admin_btn sm" onClick={reset}>
            取消编辑
          </button>
        </div>
      )}

      <label style={labelStyle}>
        比赛全名
        <input
          className="admin_input"
          maxLength={100}
          placeholder="如：第一届元旦冲榜赛"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </label>

      <div style={twoCol}>
        <label style={labelStyle}>
          比赛简称（3-4 字）
          <input
            className="admin_input"
            maxLength={10}
            placeholder="如：元旦赛"
            value={values.shortName}
            onChange={(e) => set("shortName", e.target.value)}
          />
        </label>
        <label style={labelStyle}>
          发起人 ID
          <input
            className="admin_input"
            inputMode="numeric"
            placeholder="如：10001"
            value={values.creatorId}
            onChange={(e) => set("creatorId", e.target.value)}
          />
        </label>
      </div>

      <div style={twoCol}>
        <label style={labelStyle}>
          开始时间（北京时间）
          <input
            className="admin_input"
            type="datetime-local"
            value={values.startTime}
            onChange={(e) => set("startTime", e.target.value)}
          />
        </label>
        <label style={labelStyle}>
          结束时间（北京时间）
          <input
            className="admin_input"
            type="datetime-local"
            value={values.endTime}
            onChange={(e) => set("endTime", e.target.value)}
          />
        </label>
      </div>

      <div style={twoCol}>
        <label style={labelStyle}>
          总奖金（元）
          <input
            className="admin_input"
            inputMode="numeric"
            placeholder="如：1000"
            value={values.prizeTotal}
            onChange={(e) => set("prizeTotal", e.target.value)}
          />
        </label>
      </div>

      {/* 收录录像级别（张老师 2026-11-13：可多选，默认初中高都有）——
          决定本比赛收录哪些级别的录像，前台列表页/详情页信息行展示 */}
      <div style={labelStyle}>
        收录录像级别（可多选，决定本比赛收录哪些级别的录像）
        <div style={{ display: "flex", gap: 16 }}>
          {ALL_LEVELS.map((lv) => (
            <label
              key={lv}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2", cursor: "pointer" }}
            >
              <input type="checkbox" checked={levels.includes(lv)} onChange={() => toggleLevel(lv)} />
              {LEVEL_LABELS[lv]}
            </label>
          ))}
        </div>
      </div>

      {/* 成绩计算方式（张老师 2026-11-13 四期：创建/编辑时配置，可扩展更多方式）——
          决定玩家列表「当前成绩」怎么算：sum_topn=各级别最好 N 局 time 加总；
          target_diff=与指定 time 的最小误差（越小越好） */}
      <div style={labelStyle}>
        成绩计算方式（决定玩家「当前成绩」怎么算，均为越小越好）
        <select
          className="admin_input"
          value={scoreMode}
          onChange={(e) => setScoreMode(e.target.value)}
        >
          <option value="">未配置（暂不计成绩）</option>
          <option value="sum_topn">成绩加总（各级别最好 N 局 time 求和）</option>
          <option value="target_diff">目标成绩求差（与指定 time 的最小误差）</option>
        </select>
        {scoreMode === "sum_topn" && (
          <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
            {ALL_LEVELS.map((lv) => (
              <label key={lv} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2" }}>
                {LEVEL_LABELS[lv]}
                <input
                  className="admin_input"
                  style={{ width: 64 }}
                  inputMode="numeric"
                  value={topn[lv]}
                  onChange={(e) => setTopn((s) => ({ ...s, [lv]: e.target.value }))}
                />
                局
              </label>
            ))}
          </div>
        )}
        {scoreMode === "target_diff" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2", marginTop: 4 }}>
            目标 time（秒）
            <input
              className="admin_input"
              style={{ width: 100 }}
              inputMode="decimal"
              placeholder="如：8.88"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
        )}
      </div>

      <label style={labelStyle}>
        分配方案（每行一名次，前台 hover 总奖金时展示）
        <textarea
          className="admin_textarea"
          rows={3}
          maxLength={500}
          placeholder={"第一名 ¥600\n第二名 ¥300\n第三名 ¥100"}
          value={values.prizePlan}
          onChange={(e) => set("prizePlan", e.target.value)}
        />
      </label>

      <label style={labelStyle}>
        比赛规则
        <textarea
          className="admin_textarea"
          rows={4}
          maxLength={1000}
          placeholder="如：初级、中级盘各一次，取最好成绩排名；须使用站内练习页指定模式完成，成绩自动计入。"
          value={values.rules}
          onChange={(e) => set("rules", e.target.value)}
        />
      </label>

      <div>
        <button type="submit" className="admin_btn primary" disabled={busy}>
          {busy ? "提交中…" : editing ? "保存修改" : "发起比赛"}
        </button>
        <span className="admin_hint" style={{ marginLeft: 10 }}>
          比赛标识创建时自动生成，前台开始前显示「待定」
        </span>
      </div>
    </form>
  );
}
