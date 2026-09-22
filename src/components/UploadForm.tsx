// 上传表单（替代旧版 plupload：现代浏览器单文件直传，无需分块/Flash）

"use client";

import { useRef, useState } from "react";

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function UploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setMessage(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/video/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? "上传失败" });
        return;
      }
      setMessage({ ok: true, text: "上传成功，请等待管理员审核" });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } finally {
      setUploading(false);
    }
  }

  return (
    <form id="upload-form" onSubmit={submit}>
      <div id="filelist" className="form">
        {file && (
          <div className="progressBar">
            <div className="title">
              <span className="name">
                {file.name}（{formatSize(file.size)}）
              </span>
            </div>
          </div>
        )}
      </div>
      <p>
        <input
          ref={inputRef}
          type="file"
          accept=".mvf,.avf"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setMessage(null);
          }}
        />
      </p>
      <p>
        <button type="submit" className={`button ${file && !uploading ? "active" : "disabled"}`} disabled={!file || uploading}>
          {uploading ? "上传中…" : "开始上传"}
        </button>
      </p>
      {message && (
        <p className={message.ok ? "hint" : "error"} style={message.ok ? {} : { color: "#d33" }}>
          {message.text}
        </p>
      )}
    </form>
  );
}
