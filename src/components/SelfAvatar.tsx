// 自己主页的头像（2026-09-24 张老师需求）
//
// 交互：点击头像 → 直接弹出系统文件选择窗口 → 选中后出方形裁剪预览浮窗 →
//       确认上传。不再跳转账号中心。
// 状态：有头像正在审核时，头像下方常显灰色半透明「审核中」气泡；
//       hover 时气泡上移，把底部让给「点击更换头像」提示条。
//
// 只有登录用户浏览自己的主页时才会挂载这个组件——别人的主页仍是裸 <img>。

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AvatarCropper, useAvatarPick, type CropResult } from "./AvatarCropper";
import { toast } from "./Toast";

interface Props {
  /** 当前生效的头像 URL */
  src: string;
  alt: string;
  /** 服务端查到的「有待审头像」状态 */
  pending: boolean;
}

export function SelfAvatar({ src, alt, pending }: Props) {
  const router = useRouter();
  const { inputRef, pickedUrl, setPickedUrl, onPick } = useAvatarPick();
  const [note, setNote] = useState<{ kind: "ok" | "pending"; text: string } | null>(null);

  // 「头像已更新」提示 3.5 秒后自动收起；「审核中」一直留到刷新后由服务端状态接管
  useEffect(() => {
    if (note?.kind !== "ok") return;
    const t = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(t);
  }, [note]);

  function onDone(r: CropResult) {
    setPickedUrl(null);
    setNote(r.auto ? { kind: "ok", text: "头像已更新" } : { kind: "pending", text: "审核中" });
    toast(r.auto ? "头像已更新" : "已提交，等待管理员审核", "success");
    router.refresh();
  }

  const reviewing = pending || note?.kind === "pending";

  return (
    <>
      <button
        type="button"
        className="avatar_slot"
        onClick={() => inputRef.current?.click()}
        aria-label="点击更换头像"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="avatar" src={src} alt={alt} />
        {reviewing && <span className="avatar_status">审核中</span>}
        {note?.kind === "ok" && <span className="avatar_status ok">{note.text}</span>}
        <span className="avatar_change">点击更换头像</span>
      </button>

      <input ref={inputRef} type="file" accept="image/*" hidden onChange={onPick} />

      {pickedUrl && (
        <AvatarCropper
          previewUrl={pickedUrl}
          onCancel={() => setPickedUrl(null)}
          onDone={onDone}
        />
      )}
    </>
  );
}
