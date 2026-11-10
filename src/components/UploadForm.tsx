// 上传表单（批量版：加号选文件 / 全页拖拽，复用旧版 plupload 的 progressBar 交互样式）

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "./Toast";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvf } from "@/lib/mvf";
import { evfToRawvf } from "@/lib/evf";
import { rmvToRawvf } from "@/lib/rmv";
import { formatRawvf, checkProgramVersion } from "@/lib/rawvf";
import { scoreTime } from "@/lib/format";

const MAX_SIZE = 500 * 1024; // 与服务端一致（旧版 plupload max_file_size: 500kb）

type ItemStatus = "invalid" | "pending" | "uploading" | "success" | "error";

// 浏览器端解析出的录像信息（解析失败则无，卡片退回显示文件名）
type Meta = { level: "beg" | "int" | "exp"; timeMs: number; bbbv: number | null; noflag: boolean };

type Item = {
  key: string;
  file: File;
  status: ItemStatus;
  progress: number; // 0-100
  message: string;
  meta?: Meta;
};

// 级别标签（配色与详情页标题/录像列表 hover 同级：初级绿 / 中级橙 / 高级金）
const LEVEL_TAG: Record<Meta["level"], { label: string; color: string }> = {
  beg: { label: "初级", color: "#a6e22e" },
  int: { label: "中级", color: "#f79646" },
  exp: { label: "高级", color: "#fdc61d" },
};

/* ---- 庆祝气泡（2026-11-10 张老师需求）----
   上传录像若收集到新 BV / 打破本BV最好成绩，弹排行模式那种庆祝气泡（串行
   排队）并播放提示音；批量上传逐个结算，循环到所有提示都显示完。
   口径：服务端上传路由以收集墙同源判定（firstBv/pbBv/celebrate 随响应下发）。
   视觉：新 BV 走排行模式同款收集墙气泡（.toast_html 收集墙 + wall_fast 加速
   动画——队列节奏 2 秒/条，原版 1.8s 点亮 + 3s 停留放不下）；破本BV纪录走
   金色奖杯气泡 3 秒。声音复用练习页同款音源 bv.mp3 / record.mp3，Audio 单例
   缓存 + 串行队列（一条 ended 后隔 80ms 泵下一条，不叠音不卡死）。 */

type Celebrate = {
  newBv: number;
  wall: { values: number[]; collected: number[] } | null;
  progress: number;
  total: number;
};

/** 结算提示音版本号（与练习页 OnlinePlay SND_VER 同步维护；换音频内容必递增） */
const SND_VER = "2";
const sndCache = new Map<string, HTMLAudioElement>();
const sndQueue: string[] = [];let sndBusy = false;
function sndStart(src: string) {
  sndBusy = true;
  try {
    let a = sndCache.get(src);
    if (!a) {
      a = new Audio(`${src}?v=${SND_VER}`);
      a.preload = "auto";
      sndCache.set(src, a);
    } else {
      a.currentTime = 0;
    }
    const done = () => {
      sndBusy = false;
      window.setTimeout(pumpSnd, 80);
    };
    a.addEventListener("ended", done, { once: true });
    a.addEventListener("error", done, { once: true });
    void a.play().catch(() => done()); // 自动播放策略拒绝也放行队列
  } catch {
    sndBusy = false;
    window.setTimeout(pumpSnd, 0);
  }
}
function pumpSnd() {
  if (sndBusy || !sndQueue.length) return;
  sndStart(sndQueue.shift()!);
}
function playSoundQueued(src: string) {
  sndQueue.push(src);
  pumpSnd();
}

/** 收集墙气泡 HTML（与练习页 buildWallToastHtml 同款结构；级别三色内联注入
 *  --wall-on，墙根挂 wall_fast 走加速动画。内容全是数字/固定文案，无注入面） */
function buildWallHtml(c: Celebrate, level: Meta["level"]): string {
  const wall = c.wall;
  if (!wall || !Array.isArray(wall.values) || wall.values.length === 0) return "";
  const color = level === "int" ? "#fd971f" : level === "exp" ? "#e6db74" : "#a6e22e";
  const collectedSet = new Set(wall.collected ?? []);
  // ⚠️ flash 优先于 on：上传路由下发的 collected 已含本局新 BV（本盘先入库再取墙），
  // 与练习页（排名局核查时录像未上传、collected 不含 newBv）不同——不优先判定的话
  // 新格子直接落 on，丢失「闪亮点亮」动画。flash keyframes 终态即级别色+白框定格，
  // 语义正好是「刚收的格子亮起来并保持」
  const cells = wall.values
    .map((b) => `<span class="wall_sq${b === c.newBv ? " flash" : collectedSet.has(b) ? " on" : ""}"></span>`)
    .join("");
  const bar =
    c.progress > 0 && c.total > 0
      ? `<div class="wall_bar"><div class="wall_fill" style="width:${((c.progress / c.total) * 100).toFixed(2)}%;--w-from:${(((c.progress - 1) / c.total) * 100).toFixed(2)}%"></div></div>`
      : "";
  return (
    `<div class="bbv_wall wall_fast wall_lv_${level}" style="--wall-on:${color}">` +
    `<div class="wall_msg">恭喜收集到了${LEVEL_TAG[level].label} ${c.newBv} BV！</div>` +
    `<div class="wall_hint">已自动点亮收集墙</div>` +
    bar +
    `<div class="wall_grid">${cells}</div>` +
    `</div>`
  );
}

/** 庆祝队列项：cls gold=金色奖杯 / green=收集墙；holdMs 为在屏停留（淡出另加 380ms）；
 *  html 有值走自建 HTML 气泡（收集墙），否则走全局 toast。 */
type CelebrateItem = { msg: string; cls: "gold" | "green"; holdMs: number; html?: string };
const celebrateQueue: CelebrateItem[] = [];
let celebrateBusy = false;
function enqueueCelebrate(item: CelebrateItem) {
  celebrateQueue.push(item);
  void drainCelebrate();
}
async function drainCelebrate() {
  if (celebrateBusy) return;
  celebrateBusy = true;
  while (celebrateQueue.length) {
    const item = celebrateQueue.shift()!;
    await showCelebrateBubble(item);
  }
  celebrateBusy = false;
}
function showCelebrateBubble(item: CelebrateItem): Promise<void> {
  return new Promise((resolve) => {
    if (item.html) {
      // HTML 气泡（收集墙）：自建元素（全局 toast 只支持纯文本），fixed 居中
      // 样式全在 globals.css（.toast_bubble.toast_html 收集墙系列）
      const bubble = document.createElement("div");
      bubble.className = "toast_bubble toast_success toast_html";
      bubble.setAttribute("role", "status");
      bubble.innerHTML = item.html;
      document.body.appendChild(bubble);
      window.setTimeout(() => bubble.classList.add("toast_leave"), item.holdMs);
      window.setTimeout(() => {
        bubble.remove();
        resolve();
      }, item.holdMs + 380);
    } else if (item.cls === "gold") {
      // 金色奖杯气泡：自建 DOM（toast_gold 样式在 globals.css）。不走全局
      // toast(success)——它自动加 ✓ 图标，与 🏆 并列不合练习页定稿口径
      //（破纪录只用奖杯，2026-10-28 张老师定；2026-11-10 双对号反馈一并归此）
      const bubble = document.createElement("div");
      bubble.className = "toast_bubble toast_gold";
      bubble.setAttribute("role", "status");
      bubble.textContent = "🏆 " + item.msg;
      document.body.appendChild(bubble);
      window.setTimeout(() => bubble.classList.add("toast_leave"), item.holdMs);
      window.setTimeout(() => {
        bubble.remove();
        resolve();
      }, item.holdMs + 380);
    } else {
      // 绿色普通项（汇总气泡）：走全局 toast。success 自带 ✓ 图标即对号标记，
      // 文字前不再手写前缀（2026-11-10 张老师：手写「✓ 」会出双对号）
      toast(item.msg, "success", item.holdMs);
      window.setTimeout(resolve, item.holdMs + 380);
    }
  });
}

/** 上传成功结算：按服务端判定组装庆祝队列。声音随气泡同步入队（音效短于
 *  气泡 hold，天然串行不重叠）。运气盘（noRecord）不庆祝——成绩划线不入排行 */
function queueCelebrations(
  meta: Meta | undefined,
  res: { firstBv?: number; pbBv?: number; pbPrev?: number; celebrate?: Celebrate | null },
  okCount: number,
  total: number
) {
  if (!meta) return;
  const lvName = LEVEL_TAG[meta.level].label;
  if (res.firstBv === 1 && res.celebrate) {
    playSoundQueued("/sounds/bv.mp3");
    const msg = `恭喜收集到了${lvName} ${res.celebrate.newBv} BV！`;
    const html = buildWallHtml(res.celebrate, meta.level);
    if (html) enqueueCelebrate({ msg, cls: "green", holdMs: 2000, html });
    else enqueueCelebrate({ msg, cls: "green", holdMs: 2000 }); // 墙数据缺失兜底：纯文本
  }
  if (res.pbBv === 1) {
    playSoundQueued("/sounds/record.mp3");
    const oldT = ((res.pbPrev ?? 0) / 1000).toFixed(3);
    const newT = (meta.timeMs / 1000).toFixed(3);
    enqueueCelebrate({
      msg: `恭喜打破${lvName}${meta.bbbv}BV的时间记录！${oldT} -> ${newT}`,
      cls: "gold",
      holdMs: 3000,
    });
  }
  if (okCount > 0 && total > 0 && okCount === total) {
    // 全部传完的汇总气泡垫底（绿）：只报成功总数，失败的走行内红字 + 汇总红气泡
    enqueueCelebrate({ msg: `成功上传 ${okCount} 个录像，等待审核`, cls: "green", holdMs: 1000 });
  }
}

// fetch 不带上传进度，用 XHR 拿 progress 事件驱动 .progress 宽度。
// 服务端成功/限流响应都带 remaining（每周剩余额度权威值），用于校准本地配额推算
function uploadOne(
  file: File,
  onProgress: (pct: number) => void
): Promise<{
  ok: boolean;
  error?: string;
  remaining?: number;
  noRecord?: boolean;
  firstBv?: number;
  pbBv?: number;
  pbPrev?: number;
  celebrate?: Celebrate | null;
}> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/video/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: {
        ok?: boolean;
        error?: string;
        remaining?: number;
        noRecord?: boolean;
        firstBv?: number;
        pbBv?: number;
        pbPrev?: number;
        celebrate?: Celebrate | null;
      } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // 非 JSON 响应按失败处理
      }
      const remaining = typeof data.remaining === "number" ? data.remaining : undefined;
      if (xhr.status >= 200 && xhr.status < 300 && data.ok)
        resolve({
          ok: true,
          remaining,
          noRecord: data.noRecord === true,
          firstBv: data.firstBv,
          pbBv: data.pbBv,
          pbPrev: data.pbPrev,
          celebrate: data.celebrate ?? null,
        });
      else resolve({ ok: false, error: data.error ?? `上传失败（HTTP ${xhr.status}）`, remaining });
    };
    xhr.onerror = () => resolve({ ok: false, error: "网络错误，上传中断" });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export function UploadForm({ initialRemaining }: { initialRemaining: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]); // items 的同步镜像：addFiles 去重/追加需要立即可读的最新值
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState<[number, number] | null>(null); // [已完成, 总数]
  const [dragOver, setDragOver] = useState(false);
  // 每周上传额度（2026-11-02 张老师定）：服务端权威值 + 列表待传数实时推算显示值。
  // 加文件即扣、删文件即还（queued 模型天然实现）；每传完一个用服务端返回的
  // remaining 校准 serverRemaining，消除本地推算与服务端的漂移。
  const [serverRemaining, setServerRemaining] = useState(initialRemaining);
  const [quotaBubble, setQuotaBubble] = useState(false); // 超配额红色气泡
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showQuotaBubble = useCallback(() => {
    setQuotaBubble(true);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setQuotaBubble(false), 3000);
  }, []);
  useEffect(() => () => {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
  }, []);

  // 所有 items 变更统一走这里，保持 ref 镜像同步
  const applyItems = useCallback((next: Item[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  // 浏览器端复用服务端同款解析器，选入即解析出级别/成绩/3BV（仅作展示，不影响服务端权威校验）
  const parseMeta = useCallback(
    (key: string, file: File, ext: string) => {
      file
        .arrayBuffer()
        .then((ab) => {
          const bytes = new Uint8Array(ab);
          const lines =
            ext === "avf"
              ? avfToRawvf(bytes)
              : ext === "evf"
                ? evfToRawvf(bytes)
                : ext === "rmv"
                  ? rmvToRawvf(bytes)
                  : mvfToRawvf(bytes);
          if (!lines) return;
          const { level, timeMs, bbbv, noflag, program, version } = formatRawvf(lines);
          // 最低软件版本（与服务端 checkProgramVersion 同源）：低于即直接标红拦下，不给上传
          const tooOld = checkProgramVersion(program, version);
          if (tooOld) {
            applyItems(
              itemsRef.current.map((i) =>
                i.key === key ? { ...i, status: "invalid" as const, message: tooOld } : i
              )
            );
            return;
          }
          if (level === "beg" || level === "int" || level === "exp") {
            const meta: Meta = { level, timeMs, bbbv, noflag };
            applyItems(itemsRef.current.map((i) => (i.key === key ? { ...i, meta } : i)));
          }
        })
        .catch(() => {
          // 解析失败不显示成绩，交由服务端上传时给出具体错误
        });
    },
    [applyItems]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const seen = new Set(itemsRef.current.map((i) => `${i.file.name}|${i.file.size}|${i.file.lastModified}`));
      // 剩余可入列的待传名额（2026-11-02 张老师定：超配额文件直接拦下不让入列，
      // 不只提示）。invalid 文件不占额度，照常入列展示错误。
      const queuedBefore = itemsRef.current.filter(
        (i) => i.status === "pending" || i.status === "uploading"
      ).length;
      let slots = Math.max(0, serverRemaining - queuedBefore);
      let blocked = 0;
      const added: Item[] = [];
      for (const file of Array.from(files)) {
        const id = `${file.name}|${file.size}|${file.lastModified}`;
        if (seen.has(id)) continue; // 拖拽/重复选择去重
        seen.add(id);
        const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
        let status: ItemStatus = "pending";
        let message = "";
        if (ext !== "mvf" && ext !== "avf" && ext !== "evf" && ext !== "rmv") {
          status = "invalid";
          message = "只支持 mvf / avf / evf / rmv 格式的录像";
        } else if (file.size > MAX_SIZE) {
          status = "invalid";
          message = "文件大小不能超过 500KB";
        }
        if (status === "pending") {
          if (slots <= 0) {
            blocked++;
            continue; // 超出额度：不入列
          }
          slots--;
        }
        added.push({ key: `${Date.now()}-${seqRef.current++}`, file, status, progress: 0, message });
      }
      if (added.length === 0) {
        if (blocked > 0) showQuotaBubble();
        return;
      }
      if (blocked > 0) showQuotaBubble();
      applyItems([...itemsRef.current, ...added]);
      for (const item of added) {
        if (item.status !== "pending") continue;
        const ext = item.file.name.slice(item.file.name.lastIndexOf(".") + 1).toLowerCase();
        parseMeta(item.key, item.file, ext);
      }
    },
    [applyItems, parseMeta, serverRemaining, showQuotaBubble]
  );

  const update = useCallback(
    (key: string, patch: Partial<Item>) => {
      applyItems(itemsRef.current.map((i) => (i.key === key ? { ...i, ...patch } : i)));
    },
    [applyItems]
  );

  // 全页拖拽：dragover 阻止默认行为后，落到页面任意位置的文件都会进列表
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      setDragOver(false); // 无论落点在哪都清除加号区高亮
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  const uploadable = items.filter((i) => i.status === "pending" || i.status === "error");

  async function startUpload() {
    if (busy || uploadable.length === 0) return;
    // 上传顺序（2026-11-05 张老师定）：先传慢的后传快的——首页信息流按上传时间倒序
    // 展示，成绩最好的几盘最后传才能排在信息流最前面；未解析出成绩的排最前面
    const targets = items
      .filter((i) => i.status === "pending" || i.status === "error")
      .sort((a, b) => {
        const ta = a.meta?.timeMs;
        const tb = b.meta?.timeMs;
        if (ta === undefined && tb === undefined) return 0;
        if (ta === undefined) return -1;
        if (tb === undefined) return 1;
        return tb - ta; // 耗时大（慢）在前
      });
    setBusy(true);
    let done = 0;
    let okCount = 0;
    let failCount = 0;
    setSeq([done, targets.length]);
    for (const item of targets) {
      update(item.key, { status: "uploading", progress: 0, message: "" });
      const res = await uploadOne(item.file, (pct) => update(item.key, { progress: pct }));
      // 服务端权威校准（成功与限流响应都带 remaining）；列表待传数随状态流转
      // 自动增减，显示值无需在此额外扣减
      if (typeof res.remaining === "number") setServerRemaining(res.remaining);
      if (res.ok) {
        // 运气盘（2026-11-02 张老师定）：低于级别 3BV 下限允许上传但成绩划线不入排行，
        // 行内提示与普通成功区分
        update(item.key, {
          status: "success",
          progress: 100,
          message: res.noRecord
            ? "上传成功，等待审核（3BV 低于级别下限，成绩不计入排行）"
            : "上传成功，等待审核",
        });
        okCount++;
        // 庆祝气泡（2026-11-10 张老师需求）：新收集 BV / 破本BV最好成绩，
        // 排行模式同款串行气泡 + 提示音（运气盘 noRecord 不庆祝）
        if (!res.noRecord) {
          const cur = item; // 闭包内捕获（meta 解析是异步的，取此刻卡片元数据）
          queueCelebrations(cur.meta, res, okCount, targets.length);
        }
      } else {
        update(item.key, { status: "error", message: res.error ?? "上传失败" });
        failCount++;
      }
      done++;
      setSeq([done, targets.length]);
    }
    setBusy(false);
    setSeq(null);
    // 汇总气泡：全成功绿（已并入庆祝队列尾，见 queueCelebrations）、有失败红（行内逐条状态保留）
    if (failCount > 0) {
      toast(`${okCount} 个上传成功，${failCount} 个失败`, "error");
    } else if (okCount === 0) {
      toast(`成功上传 ${okCount} 个录像，等待审核`, "success");
    }
  }

  const plusColor = dragOver ? "#a6e22e" : "#75715e";

  // 列表待传数（pending + uploading）：加文件即扣、删/传完即还
  const queued = items.filter((i) => i.status === "pending" || i.status === "uploading").length;
  const remaining = Math.max(0, serverRemaining - queued);

  return (
    <div id="upload-form">
      {/* 加号选择区：点击打开文件选择器，也可拖拽（拖到页面任意位置同样生效） */}
      <div
        role="button"
        tabIndex={0}
        aria-label="选择或拖拽录像文件"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          if (e.dataTransfer?.types.includes("Files")) setDragOver(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={() => setDragOver(false)}
        style={{
          height: 150,
          border: `1px ${dragOver ? "solid #a6e22e" : "dashed #49483e"}`,
          borderRadius: 5,
          background: dragOver ? "#32322b" : "#272822",
          cursor: "pointer",
          textAlign: "center",
          userSelect: "none",
          transition: "border-color .2s, background-color .2s",
        }}
      >
        {/* 纯 CSS 加号（两根横竖条，天然居中） */}
        <span style={{ position: "relative", display: "inline-block", width: 48, height: 48, marginTop: 26 }}>
          <span
            style={{
              position: "absolute",
              left: "50%",
              top: 0,
              width: 2,
              height: 48,
              background: plusColor,
              transform: "translateX(-50%)",
              transition: "background-color .2s",
            }}
          />
          <span
            style={{
              position: "absolute",
              top: "50%",
              left: 0,
              height: 2,
              width: 48,
              background: plusColor,
              transform: "translateY(-50%)",
              transition: "background-color .2s",
            }}
          />
        </span>
        <span style={{ display: "block", color: dragOver ? "#a6e22e" : "#75715e", fontSize: 14, lineHeight: "24px", transition: "color .2s" }}>
          {dragOver ? "松开鼠标即可添加" : "点击选择录像文件，或将文件拖拽到页面任意位置"}
        </span>
        <span style={{ display: "block", color: "#49483e", fontSize: 12, lineHeight: "20px" }}>
          支持 mvf / avf / evf / rmv，可批量选择，单个文件不超过 500KB
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mvf,.avf,.evf,.rmv"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = ""; // 允许再次选择同一文件
        }}
      />
      <div id="filelist">
        {items.map((item) => (
          <div
            key={item.key}
            className={`progressBar ${item.status === "success" ? "success" : item.status === "invalid" || item.status === "error" ? "error" : ""}`}
          >
            <div className="title">
              <span className="name">
                {item.meta ? (
                  <>
                    <span
                      style={{
                        color: LEVEL_TAG[item.meta.level].color,
                        border: `1px solid ${LEVEL_TAG[item.meta.level].color}`,
                        borderRadius: 3,
                        fontSize: 12,
                        lineHeight: "16px",
                        padding: "0 4px",
                      }}
                    >
                      {LEVEL_TAG[item.meta.level].label}
                    </span>
                    <b>{scoreTime(item.meta.timeMs) || "—"}</b>
                    {item.meta.noflag && <span style={{ color: "#75715e", fontSize: 12 }}>NF</span>}
                    <span style={{ color: "#939387" }}>
                      3BV <b style={{ color: "#b1b1a4" }}>{item.meta.bbbv ?? "—"}</b>
                    </span>
                  </>
                ) : (
                  // 未解析出信息（非法文件 / 解析失败）才退回显示文件名
                  <span style={{ fontSize: 12 }}>{item.file.name}</span>
                )}
              </span>
              <span className="message">
                {item.message || (item.status === "uploading" ? `上传中 ${item.progress}%` : "")}
              </span>
            </div>
            <span
              className="progress"
              style={{ width: `${item.status === "uploading" ? item.progress : 0}%` }}
            />
            <a
              className="cancel"
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.preventDefault();
                if (item.status !== "uploading") applyItems(itemsRef.current.filter((i) => i.key !== item.key));
              }}
            />
          </div>
        ))}
      </div>
      {/* 开始上传常驻（无文件 / 上传中置灰）；清空列表仅在列表有文件时出现。
          配额行绝对定位左侧（2026-11-02 张老师：不影响按钮排版），正文字号 14px */}
      <p style={{ textAlign: "center", position: "relative" }}>
        <span
          style={{
            position: "absolute",
            left: 12,
            top: "50%",
            transform: "translateY(-50%)",
            color: "#939387",
          }}
        >
          {/* 超配额红色气泡（3 秒自动消隐） */}
          {quotaBubble && (
            <span
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                left: 0,
                background: "#f92672",
                color: "#fff",
                fontSize: 12,
                lineHeight: "18px",
                padding: "4px 10px",
                borderRadius: 4,
                whiteSpace: "nowrap",
                boxShadow: "0 2px 8px rgba(0,0,0,.4)",
                zIndex: 10,
              }}
            >
              你本周的录像上传额度已用完
              <span
                style={{
                  position: "absolute",
                  top: "100%",
                  left: "50%",
                  transform: "translateX(-50%)",
                  border: "5px solid transparent",
                  borderTopColor: "#f92672",
                }}
              />
            </span>
          )}
          您现在还能上传 <b style={{ color: "#a6e22e" }}>{remaining}</b> 个录像
        </span>
        <button
          type="button"
          className={`button big ${!busy && uploadable.length > 0 ? "active" : "disabled"}`}
          disabled={busy || uploadable.length === 0}
          onClick={startUpload}
        >
          {/* 上传图标：currentColor 跟随按钮文字色（可点绿 / 置灰暗） */}
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ verticalAlign: "-4px", marginRight: 8 }}
            aria-hidden="true"
          >
            <path d="M12 16V4" />
            <path d="M6 10l6-6 6 6" />
            <path d="M4 20h16" />
          </svg>
          {seq ? `上传中（${seq[0]}/${seq[1]}）…` : "开始上传"}
        </button>
        {items.length > 0 && (
          <button
            type="button"
            className={`button big ${busy ? "disabled" : ""}`}
            style={{ marginLeft: 12 }}
            disabled={busy}
            onClick={() => applyItems([])}
          >
            清空列表
          </button>
        )}
      </p>
    </div>
  );
}
