// 头像上传（2026-09-24 张老师需求：个人资料页点击上传 + AI 初审 + 人工复核）
//
// 前端职责：
//   1. 点击缩略图 → 系统文件选择
//   2. 选中后交给 AvatarCropper：方形裁剪预览 → 用户确认 → canvas 导出
//      400px JPEG（同时完成格式归一化与 EXIF 剥离）→ 上传
//   3. 上传结果反馈：AI 放行则头像立即更新，转人工则提示等待审核
//
// 归一化/裁剪逻辑为什么必须在前端做（不是优化）：
//   · 智谱视觉接口只吃 JPEG/PNG，GIF 与 HEIC 直接 400（iPhone 默认拍 HEIC）
//   · 手机原图 3~8MB，base64 后更大，AI 调用会逼近超时（实测 1.6MB 要 2.1 秒）
//   · canvas 导出的 JPEG 不带 EXIF，顺带去掉拍摄地点等隐私信息

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AvatarCropper, useAvatarPick, type CropResult } from "./AvatarCropper";

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

export function AvatarUploader({ currentUrl, pendingUrl, pendingReason, rejected }: Props) {
  const router = useRouter();
  const { inputRef, pickedUrl, setPickedUrl, onPick } = useAvatarPick();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function onDone(r: CropResult) {
    setPickedUrl(null);
    setMessage({ ok: true, text: r.auto ? "头像已更新" : r.message });
    router.refresh();
  }

  // 展示图优先级：待审图（若有）→ 当前生效头像
  const shown = pendingUrl || currentUrl;

  return (
    // id="avatar"：外部（如自己主页）可跳 /account/profile#avatar 直接定位到这一行
    <tr id="avatar">
      <th>头像</th>
      <td>
        <div className="avatar_uploader">
          <button
            type="button"
            className="avatar_pick"
            onClick={() => inputRef.current?.click()}
            disabled={!!pickedUrl}
            title="点击更换头像"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shown} alt="我的头像" />
            <span className="avatar_mask">点击更换</span>
            {pendingUrl && <span className="avatar_flag">审核中</span>}
          </button>

          <input ref={inputRef} type="file" accept="image/*" hidden onChange={onPick} />

          <div className="avatar_tip">
            <p>
              点击左侧图片选择照片，仅接受<b>本人真实照片</b>（不收卡通、动漫、风景、表情包）。
            </p>
            <p>
              选好后可先裁剪成正方形再提交；提交后<b>需经审核才会生效</b>，审核期间原头像继续对外展示。
            </p>
            {pendingReason && <p className="hint">上一张正在审核中：{pendingReason}</p>}
            {rejected && <p className="error">上次上传未通过：{rejected.reason}</p>}
            {message && <p className={message.ok ? "hint" : "error"}>{message.text}</p>}
          </div>
        </div>

        {pickedUrl && (
          <AvatarCropper
            previewUrl={pickedUrl}
            onCancel={() => setPickedUrl(null)}
            onDone={onDone}
          />
        )}
      </td>
    </tr>
  );
}
