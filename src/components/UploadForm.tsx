// 上传表单（批量版：加号选文件 / 全页拖拽，复用旧版 plupload 的 progressBar 交互样式）

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "./Toast";
import { avfToRawvf } from "@/lib/avf";
import { mvfToRawvf } from "@/lib/mvf";
import { evfToRawvf } from "@/lib/evf";
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

// fetch 不带上传进度，用 XHR 拿 progress 事件驱动 .progress 宽度
function uploadOne(file: File, onProgress: (pct: number) => void): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/video/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: { ok?: boolean; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // 非 JSON 响应按失败处理
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) resolve({ ok: true });
      else resolve({ ok: false, error: data.error ?? `上传失败（HTTP ${xhr.status}）` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "网络错误，上传中断" });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export function UploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]); // items 的同步镜像：addFiles 去重/追加需要立即可读的最新值
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState<[number, number] | null>(null); // [已完成, 总数]
  const [dragOver, setDragOver] = useState(false);

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
            ext === "avf" ? avfToRawvf(bytes) : ext === "evf" ? evfToRawvf(bytes) : mvfToRawvf(bytes);
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
      const added: Item[] = [];
      for (const file of Array.from(files)) {
        const id = `${file.name}|${file.size}|${file.lastModified}`;
        if (seen.has(id)) continue; // 拖拽/重复选择去重
        seen.add(id);
        const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
        let status: ItemStatus = "pending";
        let message = "";
        if (ext !== "mvf" && ext !== "avf" && ext !== "evf") {
          status = "invalid";
          message = "只支持 mvf / avf / evf 格式的录像";
        } else if (file.size > MAX_SIZE) {
          status = "invalid";
          message = "文件大小不能超过 500KB";
        }
        added.push({ key: `${Date.now()}-${seqRef.current++}`, file, status, progress: 0, message });
      }
      if (added.length === 0) return;
      applyItems([...itemsRef.current, ...added]);
      for (const item of added) {
        if (item.status !== "pending") continue;
        const ext = item.file.name.slice(item.file.name.lastIndexOf(".") + 1).toLowerCase();
        parseMeta(item.key, item.file, ext);
      }
    },
    [applyItems, parseMeta]
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
    const targets = items.filter((i) => i.status === "pending" || i.status === "error");
    setBusy(true);
    let done = 0;
    let okCount = 0;
    setSeq([done, targets.length]);
    for (const item of targets) {
      update(item.key, { status: "uploading", progress: 0, message: "" });
      const res = await uploadOne(item.file, (pct) => update(item.key, { progress: pct }));
      if (res.ok) {
        update(item.key, { status: "success", progress: 100, message: "上传成功，等待审核" });
        okCount++;
      } else update(item.key, { status: "error", message: res.error ?? "上传失败" });
      done++;
      setSeq([done, targets.length]);
    }
    setBusy(false);
    setSeq(null);
    // 汇总气泡：全成功绿、有失败红（行内逐条状态保留）
    if (okCount === targets.length) {
      toast(`成功上传 ${okCount} 个录像，等待审核`, "success");
    } else {
      toast(`${okCount} 个上传成功，${targets.length - okCount} 个失败`, "error");
    }
  }

  const plusColor = dragOver ? "#a6e22e" : "#75715e";

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
          支持 mvf / avf / evf，可批量选择，单个文件不超过 500KB
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mvf,.avf,.evf"
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
      {/* 开始上传常驻（无文件 / 上传中置灰）；清空列表仅在列表有文件时出现 */}
      <p style={{ textAlign: "center" }}>
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
