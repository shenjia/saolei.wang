// 头像上传（2026-09-24 张老师需求：个人资料页点击上传 + AI 初审 + 人工复核）
//
// 前端职责：把用户选的任意图片**归一化成 400px 的 JPEG** 再上传。
// 这一步是必须的，不是优化：
//   · 智谱视觉接口只吃 JPEG/PNG，GIF 与 HEIC 直接 400（iPhone 默认拍 HEIC）
//   · 手机原图 3~8MB，base64 后更大，AI 调用会逼近超时（实测 1.6MB 要 2.1 秒）
//   · canvas 导出的 JPEG 不带 EXIF，顺带去掉拍摄地点等隐私信息
// 归一化失败（浏览器解不开的格式）就在本地拦下，给明确提示，不浪费一次上传。

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** 归一化后最长边像素：站内最大展示 160px（#user_view），400 足够覆盖 2x 屏 */
const MAX_SIDE = 400;
const JPEG_QUALITY = 0.85;

interface Props {
  /** 当前生效的头像 URL */
  currentUrl: string;
  /** 待审核的头像 URL（没有则不传） */
  pendingUrl?: string | null;
  /** 待审原因（AI 初审说明），展示给用户看 */
  pendingReason?: string;
  /** 最近一次被驳回的记录（展示原因） */
  rejected?: { reason: string } | null;
}

type Phase = "idle" | "working" | "uploading";

/** 用 <img> 解码而非 createImageBitmap：Safari 对 HEIC 的原生解码走这条路径更稳 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

/** 缩放并转成 JPEG（顺带剥掉 EXIF）；现代浏览器会按 EXIF 方向自动摆正后再绘制 */
async function normalize(file: File): Promise<Blob> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(img, 0, 0, w, h);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode"))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

export function AvatarUploader({ currentUrl, pendingUrl, pendingReason, rejected }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const busy = phase !== "idle";

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续选同一个文件
    if (!file) return;

    setMessage(null);
    setPhase("working");

    let blob: Blob;
    try {
      blob = await normalize(file);
    } catch {
      setPhase("idle");
      setMessage({ ok: false, text: "无法读取这张图片，请改用 JPG / PNG 格式的照片" });
      return;
    }

    // 本地先给出预览，不等服务端
    const localUrl = URL.createObjectURL(blob);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return localUrl;
    });

    setPhase("uploading");
    try {
      const fd = new FormData();
      fd.append("avatar", blob, "avatar.jpg");
      const res = await fetch("/api/account/avatar", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? "上传失败，请稍后重试" });
        return;
      }
      setMessage({
        ok: true,
        text: data.auto ? "头像已更新" : (data.message ?? "已提交，等待管理员审核"),
      });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "网络异常，请稍后重试" });
    } finally {
      setPhase("idle");
    }
  }

  // 展示图优先级：本地预览（刚上传）→ 待审图（若有）→ 当前生效头像
  const shown = preview ?? (pendingUrl || currentUrl);

  return (
    <tr>
      <th>头像</th>
      <td>
        <div className="avatar_uploader">
          <button
            type="button"
            className="avatar_pick"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            title="点击更换头像"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shown} alt="我的头像" />
            <span className="avatar_mask">
              {phase === "working" ? "处理中…" : phase === "uploading" ? "上传中…" : "点击更换"}
            </span>
            {pendingUrl && !preview && <span className="avatar_flag">审核中</span>}
          </button>

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onPick}
          />

          <div className="avatar_tip">
            <p>
              点击左侧图片选择照片，仅接受<b>本人真实照片</b>（不收卡通、动漫、风景、表情包）。
            </p>
            <p>
              图片会先由系统自动审核，拿不准的转人工复核；<b>审核通过前头像不会对外变化</b>。
            </p>
            {pendingReason && (
              <p className="hint">上一张正在审核中：{pendingReason}</p>
            )}
            {rejected && <p className="error">上次上传未通过：{rejected.reason}</p>}
            {message && (
              <p className={message.ok ? "hint" : "error"}>{message.text}</p>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
