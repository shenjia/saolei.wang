// 上传表单（批量版：加号选文件 / 全页拖拽，复用旧版 plupload 的 progressBar 交互样式）

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SIZE = 500 * 1024; // 与服务端一致（旧版 plupload max_file_size: 500kb）

type ItemStatus = "invalid" | "pending" | "uploading" | "success" | "error";

type Item = {
  key: string;
  file: File;
  status: ItemStatus;
  progress: number; // 0-100
  message: string;
};

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

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
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState<[number, number] | null>(null); // [已完成, 总数]
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback((files: FileList | File[]) => {
    setItems((prev) => {
      const seen = new Set(prev.map((i) => `${i.file.name}|${i.file.size}|${i.file.lastModified}`));
      const next = [...prev];
      for (const file of Array.from(files)) {
        const id = `${file.name}|${file.size}|${file.lastModified}`;
        if (seen.has(id)) continue; // 拖拽/重复选择去重
        seen.add(id);
        const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
        let status: ItemStatus = "pending";
        let message = "";
        if (ext !== "mvf" && ext !== "avf") {
          status = "invalid";
          message = "只支持 mvf / avf 格式的录像";
        } else if (file.size > MAX_SIZE) {
          status = "invalid";
          message = "文件大小不能超过 500KB";
        }
        next.push({ key: `${Date.now()}-${seqRef.current++}`, file, status, progress: 0, message });
      }
      return next;
    });
  }, []);

  const update = useCallback((key: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

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
    setSeq([done, targets.length]);
    for (const item of targets) {
      update(item.key, { status: "uploading", progress: 0, message: "" });
      const res = await uploadOne(item.file, (pct) => update(item.key, { progress: pct }));
      if (res.ok) update(item.key, { status: "success", progress: 100, message: "上传成功，等待审核" });
      else update(item.key, { status: "error", message: res.error ?? "上传失败" });
      done++;
      setSeq([done, targets.length]);
    }
    setBusy(false);
    setSeq(null);
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
          支持 mvf / avf，可批量选择，单个文件不超过 500KB
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mvf,.avf"
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
                {item.file.name}（{formatSize(item.file.size)}）
              </span>
              <span className="message">
                {item.message || (item.status === "uploading" ? `${item.progress}%` : "")}
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
                if (item.status !== "uploading") setItems((prev) => prev.filter((i) => i.key !== item.key));
              }}
            />
          </div>
        ))}
      </div>
      {items.length > 0 && (
        <p style={{ textAlign: "center" }}>
          <button
            type="button"
            className={`button big ${!busy && uploadable.length > 0 ? "active" : "disabled"}`}
            disabled={busy || uploadable.length === 0}
            onClick={startUpload}
          >
            {seq ? `上传中（${seq[0]}/${seq[1]}）…` : "开始上传"}
          </button>
          {!busy && (
            <button
              type="button"
              className="button small"
              style={{ marginLeft: 12 }}
              onClick={() => setItems([])}
            >
              清空列表
            </button>
          )}
        </p>
      )}
    </div>
  );
}
