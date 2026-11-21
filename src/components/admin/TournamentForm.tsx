"use client";

// 比赛发起/编辑表单（2026-11-13 后台「比赛管理」页）
// 字段：比赛全名 / 简称（3-4字）/ 比赛标识（默认留空，可手填或点「随机生成」5位码）/
//       起止时间（datetime-local，北京时间）/ 比赛规则 /
//       发起人 ID / 总奖金（元）/ 分配方案（每行一名次，如「第一名 ¥600」）。
// 提交走统一 /api/admin/action（tournament.add / tournament.edit）。
// 编辑模式：清单行「编辑」按钮派发 sl-comp-edit 事件回填，可取消。

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/Toast";
import { TOUR_METRICS, TOUR_METRIC_KEYS, type TourMetricKey } from "@/lib/tour-metric";

export interface TourFormRow {
  id: number;
  name: string;
  shortName: string;
  code: string; // 统一比赛标识（""=未设置，比赛开始后自动生成不可改）
  alias: string; // 比赛代号（""=未设置；用于详情页链接 /tournaments/<alias>）
  windowHours: number; // 个人计时窗口小时数（0=统一计时集体赛）
  startTime: string; // "YYYY-MM-DD HH:mm"
  endTime: string;
  rules: string;
  creatorId: number;
  prizeTotal: number;
  prizePlan: string;
  levels: string[]; // 收录录像级别（beg/int/exp 子集）
  scoreMode: string; // ""=未配置 / sum_topn / target_diff
  scoreConf: (Record<string, number> & { floor?: Record<string, number> }) | null; // 解析后的计算参数（未配置 null）
  scoreMetric?: string; // 计分数据项（2026-11-21 多数据项改造；旧配置缺省 time）
  scoreDesc?: boolean; // 方向（desc=true 越大越好；旧配置缺省按项默认）
}

/** 库里 Unix 秒 → datetime-local input 值（北京时间 YYYY-MM-DDTHH:mm） */
function cstInput(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const EMPTY = { name: "", shortName: "", code: "", alias: "", startTime: "", endTime: "", rules: "", creatorId: "", prizeTotal: "", prizePlan: "" };

/** 新建默认起止时间（张老师 2026-11-13：当天北京 20:00 起，7 日后 20:00 止） */
function defaultTimeInput(offsetDays: number): string {
  const d = new Date(Date.now() + (8 * 3600 + offsetDays * 86400) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T20:00`;
}
const newDefaults = () => ({ startTime: defaultTimeInput(0), endTime: defaultTimeInput(7) });
const ALL_LEVELS = ["beg", "int", "exp"] as const;
const LEVEL_LABELS: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };

export function TournamentForm() {
  const router = useRouter();
  const [values, setValues] = useState({ ...EMPTY });
  // 收录录像级别（张老师 2026-11-13：可多选，默认初中高都有）
  const [levels, setLevels] = useState<string[]>([...ALL_LEVELS]);
  // 成绩计算方式（张老师 2026-11-13 四期：创建/编辑时配置，后续可扩更多方式）
  const [scoreMode, setScoreMode] = useState("");
  // 计分数据项与方向（张老师 2026-11-21 定：六项可选 + 越大/越小越好）
  const [scoreMetric, setScoreMetric] = useState<TourMetricKey>("time");
  const [scoreDesc, setScoreDesc] = useState(false);
  // 计时模式（张老师 2026-11-19 定）：all=统一计时（全员同期开闭）/ per=个人计时
  // （选手在比赛范围内任选窗口手动开赛）；per 需填小时数（默认 2）
  const [timingMode, setTimingMode] = useState<"all" | "per">("all");
  const [windowHours, setWindowHours] = useState("2");
  // 比赛代号（alias）：默认用于详情页链接 /tournaments/<alias>，避免裸 id
  const [alias, setAlias] = useState("");
  const [topn, setTopn] = useState({ beg: "1", int: "1", exp: "1" });
  // sum_topn 各级别保底成绩（秒；张老师 2026-11-18 定，默认初10/中60/高240，盘数不足按此补足）
  const [floor, setFloor] = useState({ beg: "10", int: "60", exp: "240" });
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  // 随机生成标识中（防连点）
  const [genning, setGenning] = useState(false);
  const [editing, setEditing] = useState<(TourFormRow & { startSec?: number }) | null>(null);

  const set = (k: keyof typeof EMPTY, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const toggleLevel = (lv: string) =>
    setLevels((s) => {
      const next = s.includes(lv) ? s.filter((x) => x !== lv) : [...s, lv];
      return ALL_LEVELS.filter((a) => next.includes(a)); // 恒按初中高顺序存放
    });

  // 监听清单行「编辑」：回填记录
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent).detail as TourFormRow & { startSec: number; endSec: number };
      if (!d || typeof d.id !== "number") return;
      setEditing(d);
      setValues({
        name: d.name,
        shortName: d.shortName,
        code: d.code ?? "",
        alias: d.alias ?? "",
        startTime: cstInput(d.startSec),
        endTime: cstInput(d.endSec),
        rules: d.rules,
        creatorId: String(d.creatorId),
        prizeTotal: String(d.prizeTotal),
        prizePlan: d.prizePlan,
      });
      setLevels(d.levels.length ? [...ALL_LEVELS].filter((a) => d.levels.includes(a)) : [...ALL_LEVELS]);
      setScoreMode(d.scoreMode ?? "");
      setTimingMode(d.windowHours > 0 ? "per" : "all");
      setWindowHours(d.windowHours > 0 ? String(d.windowHours) : "2");
      setAlias(d.alias ?? "");
      // 计分数据项与方向回显（2026-11-21 多数据项：编辑行带 scoreMetric/scoreDesc；
      // 旧记录缺省回 time/项默认方向）
      const m = (d.scoreMetric ?? "time") as TourMetricKey;
      setScoreMetric(TOUR_METRIC_KEYS.includes(m) ? m : "time");
      setScoreDesc(
        d.scoreDesc !== undefined ? d.scoreDesc : (TOUR_METRICS[m]?.defaultDesc ?? false),
      );
      // 取局数回显：scoreConf 为 parseScoreConfig 的嵌套结构 {topn:{beg..},floor:{beg..}}；
      // 兼容旧平铺形态 {beg:..}（直接挂顶层）——两形态都读
      const rawTopn = (d.scoreConf as Record<string, unknown>) ?? {};
      const topnSrc = (rawTopn.topn ?? rawTopn) as Record<string, number>;
      setTopn({
        beg: String(topnSrc?.beg ?? 1),
        int: String(topnSrc?.int ?? 1),
        exp: String(topnSrc?.exp ?? 1),
      });
      // 保底回显（floor 毫秒/×1000 域 → 人类单位；旧配置无 floor 回默认值）。
      // time 惯例默认 10s/60s/240s；其余项无合理通配默认回 0（=不补保底，0 恒填）
      const floorSrc = (rawTopn.floor ?? {}) as Record<string, number>;
      const floorDefaults: Record<string, number> =
        m === "time" ? { beg: 10000, int: 60000, exp: 240000 } : { beg: 0, int: 0, exp: 0 };
      setFloor({
        beg: String(Math.round((floorSrc?.beg ?? floorDefaults.beg) / 1000)),
        int: String(Math.round((floorSrc?.int ?? floorDefaults.int) / 1000)),
        exp: String(Math.round((floorSrc?.exp ?? floorDefaults.exp) / 1000)),
      });
      setTarget(d.scoreConf?.target != null ? String(d.scoreConf.target) : "");
      // 滚动到表单（2026-11-19 张老师定：点编辑后自动跳到表单，表单在上/清单在下的布局里
      // 清单可能很长，不滚用户看不到已进入编辑态）
      document.getElementById("tour_form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("sl-comp-edit", onEdit);
    return () => window.removeEventListener("sl-comp-edit", onEdit);
  }, []);

  // 新建默认起止时间：挂载后填（避免 SSR/客户端跨天时刻的 hydration 差异）
  useEffect(() => {
    setValues((s) => (s.startTime || s.endTime ? s : { ...s, ...newDefaults() }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setEditing(null);
    setValues({ ...EMPTY, ...newDefaults() });
    setLevels([...ALL_LEVELS]);
    setScoreMode("");
    setScoreMetric("time");
    setScoreDesc(false);
    setTimingMode("all");
    setWindowHours("2");
    setAlias("");
    setTopn({ beg: "1", int: "1", exp: "1" });
    setFloor({ beg: "10", int: "60", exp: "240" });
    setTarget("");
  };

  // 随机生成 5 位标识（2026-11-18 张老师需求）：服务端查重重抽，重了再抽概率极小；
  // 返回的即「库内当前无碰撞」的可用码
  const genCode = async () => {
    if (genning) return;
    setGenning(true);
    try {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "tournament.genCode" }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
      if (data.ok && data.message) {
        set("code", data.message);
      } else {
        toast(data.error ?? "生成失败，请重试", "error");
      }
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setGenning(false);
    }
  };

  const submit = async () => {
    if (!values.name.trim()) return toast("请填写比赛全名", "error");
    if (!values.shortName.trim()) return toast("请填写比赛简称（3-4 字）", "error");
    const code = values.code.trim();
    if (code && !/^[0-9A-Za-z]{1,10}$/.test(code)) return toast("比赛标识应为 1-10 位数字或大小写字母", "error");
    // 计时模式参数（张老师 2026-11-19 定）：个人计时需 1-168 小时（1 小时~7 天）
    const wh = timingMode === "per" ? parseInt(windowHours, 10) : 0;
    if (timingMode === "per" && (!Number.isInteger(wh) || wh < 1 || wh > 168)) {
      return toast("个人计时窗口应为 1-168 小时（1 小时 ~ 7 天）", "error");
    }
    // 比赛代号（alias）：可留空；填写则 2-20 位字母数字/下划线/连字符
    const aliasTrim = alias.trim();
    if (aliasTrim && !/^[0-9A-Za-z_-]{2,20}$/.test(aliasTrim)) {
      return toast("比赛代号应为 2-20 位字母、数字、下划线或连字符", "error");
    }
    if (!values.startTime || !values.endTime) return toast("请填写起止时间", "error");
    if (values.endTime <= values.startTime) return toast("结束时间必须晚于开始时间", "error");
    if (!values.rules.trim()) return toast("请填写比赛规则", "error");
    if (!/^\d+$/.test(values.creatorId.trim())) return toast("请填写发起人 ID（纯数字 UID）", "error");
    if (!/^\d+$/.test(values.prizeTotal.trim())) return toast("总奖金应为非负整数（元）", "error");
    if (levels.length === 0) return toast("请至少勾选一个比赛级别", "error");
    // 成绩计算方式参数校验（null=配置非法，""=未配置）。
    // 2026-11-21 多数据项：metric/desc 一并落库；保底/目标单位跟随数据项
    // （time=秒，3bv/crossings=个/次，效率项=值），内部统一 ×1000 转 score 域
    let scoreConfig = "";
    if (scoreMode === "sum_topn") {
      const conf: Record<string, number> = {};
      const floorScore: Record<string, number> = {};
      let any = false;
      for (const lv of ALL_LEVELS) {
        const v = topn[lv].trim();
        if (!/^\d+$/.test(v) || parseInt(v, 10) > 99) return toast(`${LEVEL_LABELS[lv]}取局数应为 0-99 整数`, "error");
        conf[lv] = parseInt(v, 10);
        if (conf[lv] > 0) any = true;
        // 保底成绩（人类单位 → score 域 ×1000；0=不补保底，合法）
        const fv = floor[lv].trim();
        if (!/^\d+(\.\d+)?$/.test(fv) || parseFloat(fv) < 0)
          return toast(`${LEVEL_LABELS[lv]}保底成绩应为非负数（${TOUR_METRICS[scoreMetric].unit}）`, "error");
        floorScore[lv] = Math.round(parseFloat(fv) * 1000);
      }
      if (!any) return toast("成绩加总至少有一个级别取局数大于 0", "error");
      scoreConfig = JSON.stringify({ metric: scoreMetric, desc: scoreDesc, ...conf, floor: floorScore });
    } else if (scoreMode === "target_diff") {
      const n = Number(target.trim());
      if (!target.trim() || !Number.isFinite(n) || n <= 0)
        return toast(`目标成绩应为正数（${TOUR_METRICS[scoreMetric].unit}）`, "error");
      scoreConfig = JSON.stringify({ metric: scoreMetric, desc: scoreDesc, target: n });
    }

    setBusy(true);
    try {
      const payload = {
        name: values.name,
        shortName: values.shortName,
        code,
        startTime: values.startTime.replace("T", " "),
        endTime: values.endTime.replace("T", " "),
        rules: values.rules,
        creatorId: values.creatorId,
        prizeTotal: values.prizeTotal,
        prizePlan: values.prizePlan,
        levels,
        scoreMode,
        scoreConfig,
        scoreMetric,
        scoreDesc,
        alias: aliasTrim,
        windowHours: wh,
      };
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing ? { op: "tournament.edit", id: editing.id, ...payload } : { op: "tournament.add", ...payload },
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
      id="tour_form"
      style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "stretch" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void submit();
      }}
    >
      {/* 表单标题（2026-11-19 张老师定）：发起「发起比赛」/编辑「编辑比赛信息」，
          提交成功 reset 回滚「发起比赛」 */}
      <h3 style={{ margin: 0, fontSize: 16, color: "#f8f8f2" }}>
        {editing ? "编辑比赛信息" : "发起比赛"}
      </h3>
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

      {/* 比赛标识（2026-11-18 张老师需求）：默认留空=不设置（前台不展示标识行）；
          可手填（1-10 位数字/大小写字母）或点「随机生成」出 5 位码（服务端查重重抽）。
          编辑模式回填当前标识，改了才更新、不动原值 */}
      <div style={{ ...twoCol, alignItems: "end" }}>
        <label style={labelStyle}>
          统一比赛标识（可留空，比赛开始后不可更改）
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="admin_input"
              maxLength={10}
              placeholder="留空则比赛开始时自动生成"
              value={values.code}
              onChange={(e) => set("code", e.target.value)}
              style={{ flex: 1 }}
              // 比赛开始后不可更改（2026-11-19 张老师定）：输入框直接禁用
              disabled={!!editing && typeof editing.startSec === "number" && Date.now() / 1000 >= editing.startSec}
              title={editing && typeof editing.startSec === "number" && Date.now() / 1000 >= editing.startSec ? "比赛已开始，标识不可更改" : undefined}
            />
            <button
              type="button"
              className="admin_btn sm"
              onClick={() => void genCode()}
              disabled={genning || (!!editing && typeof editing.startSec === "number" && Date.now() / 1000 >= editing.startSec)}
              title="随机生成 5 位数字+大小写字母标识（自动避开已占用的）"
            >
              {genning ? "生成中…" : "随机生成"}
            </button>
          </div>
        </label>
        <label style={labelStyle}>
          比赛代号（可留空，用作链接 /tournaments/代号）
          <input
            className="admin_input"
            maxLength={20}
            placeholder="如：gsc14"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
        </label>
      </div>

      {/* 计时模式（张老师 2026-11-19 定）：统一计时=全员同期开闭（现状）；
          个人计时=选手在比赛范围内任选窗口手动开赛，窗口时长默认 2 小时 */}
      <div style={labelStyle}>
        计时模式
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2", cursor: "pointer" }}>
            <input type="radio" checked={timingMode === "all"} onChange={() => setTimingMode("all")} />
            统一计时（全员同期开始同期结束）
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2", cursor: "pointer" }}>
            <input type="radio" checked={timingMode === "per"} onChange={() => setTimingMode("per")} />
            个人计时（任选时间窗口）
          </label>
          {timingMode === "per" && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2" }}>
              窗口时长
              <input
                className="admin_input"
                style={{ width: 64 }}
                inputMode="numeric"
                value={windowHours}
                onChange={(e) => setWindowHours(e.target.value)}
              />
              小时（默认 2）
            </span>
          )}
        </div>
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
        比赛级别（可多选，决定本比赛收录哪些级别的录像）
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
          2026-11-21 多数据项改造：数据项六选一 + 方向可选，保底/目标单位跟随数据项 */}
      <div style={labelStyle}>
        成绩计算方式（决定玩家「当前成绩」怎么算）
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <select
            className="admin_input"
            style={{ width: 300 }}
            value={scoreMode}
            onChange={(e) => setScoreMode(e.target.value)}
          >
            <option value="">未配置（暂不计成绩）</option>
            <option value="sum_topn">成绩加总（各级别最好 N 局求和）</option>
            <option value="target_diff">目标成绩求差（与指定目标的最小误差）</option>
          </select>
          {scoreMode && (
            <select
              className="admin_input"
              style={{ width: 180 }}
              value={scoreMetric}
              onChange={(e) => {
                const m = e.target.value as TourMetricKey;
                setScoreMetric(m);
                setScoreDesc(TOUR_METRICS[m].defaultDesc); // 切数据项重置为默认方向
              }}
              title="计分数据项（录像的哪个指标参与计算）"
            >
              {TOUR_METRIC_KEYS.map((k) => (
                <option key={k} value={k}>
                  {TOUR_METRICS[k].name}
                </option>
              ))}
            </select>
          )}
          {scoreMode && (
            <select
              className="admin_input"
              style={{ width: 140 }}
              value={scoreDesc ? "desc" : "asc"}
              onChange={(e) => setScoreDesc(e.target.value === "desc")}
              title="成绩方向：加总时取「最好」的含义；求差仅影响展示语义"
            >
              <option value="asc">越小越好</option>
              <option value="desc">越大越好</option>
            </select>
          )}
        </div>
        {scoreMode === "sum_topn" && (
          <div style={{ display: "flex", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
            {ALL_LEVELS.map((lv) => (
              <span key={lv} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2" }}>
                {LEVEL_LABELS[lv]}
                <input
                  className="admin_input"
                  style={{ width: 64 }}
                  inputMode="numeric"
                  title="取局数（盘数不足用保底成绩补足）"
                  value={topn[lv]}
                  onChange={(e) => setTopn((s) => ({ ...s, [lv]: e.target.value }))}
                />
                局
                <input
                  className="admin_input"
                  style={{ width: 72 }}
                  inputMode="decimal"
                  title={`保底成绩（${TOUR_METRICS[scoreMetric].unit}，盘数不足按此补足；0=不补保底）`}
                  value={floor[lv]}
                  onChange={(e) => setFloor((s) => ({ ...s, [lv]: e.target.value }))}
                />
                保底
              </span>
            ))}
          </div>
        )}
        {scoreMode === "target_diff" && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#f8f8f2", marginTop: 4 }}>
            目标 {TOUR_METRICS[scoreMetric].name}（{TOUR_METRICS[scoreMetric].unit}）
            <input
              className="admin_input"
              style={{ width: 100 }}
              inputMode="decimal"
              placeholder={scoreMetric === "time" ? "如：8.88" : ""}
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
          比赛标识默认留空；设置后前台录像页按标识匹配显示比赛简称与链接
        </span>
      </div>
    </form>
  );
}
