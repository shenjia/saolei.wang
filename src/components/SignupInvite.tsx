"use client";

// 练习页游客注册邀请浮层（2026-11-05 张老师定）：
// 未登录访客每打完一局弹出邀请浮层，「马上注册」跳 /account/register，
// 「以后再说」关闭；对同一访客一天只弹一次（localStorage 按北京日期记账）。
//
// 实现口径：
// · 局末检测 = MutationObserver 盯 #gresult 的 class——core OnlinePlay 局末
//   唯一挂点是 gresult.classList.add("show")（桌面侧边浮窗与移动遮罩两形态都
//   走这一处），主仓不改 core；回放结束再弹结果面板时 show 重新出现，由
//   「一天一次」闸门自然拦住，不会重复打扰。
// · 玩家数由服务端页注入（ACTIVE_USER 口径，与首页「注册人数」同源）。
// · navigator.webdriver 会话（自动化回归）不弹，避免挡住回归脚本的盘面点击。
// · 全屏态 portal 进 fullscreenElement 子树（元素全屏下 body 直下层整体不可见，
//   同 ConfirmHost / #gr_modal 搬家先例）；退出全屏自动回 body。
// · 反作弊：浮层只在局末（over 态）出现且仅游客可见，游客无排行上报链路，
//   body 直下层不构成反作弊误报面；样式 si_* 见 globals.css。

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const LS_KEY = "signup_invite_day";

/** 北京时间当日 YYYY-MM-DD（「一天一次」的判定粒度，与站内切天口径一致） */
function todayCn(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export default function SignupInvite({ logged, players }: { logged: boolean; players: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fsHost, setFsHost] = useState<Element | null>(null);

  useEffect(() => {
    if (logged || navigator.webdriver) return;
    const syncFs = () => setFsHost(document.fullscreenElement);
    syncFs();
    document.addEventListener("fullscreenchange", syncFs);

    const gresult = document.getElementById("gresult");
    const maybeShow = () => {
      if (localStorage.getItem(LS_KEY) === todayCn()) return;
      localStorage.setItem(LS_KEY, todayCn());
      setOpen(true);
    };
    const ob = new MutationObserver(() => {
      if (gresult?.classList.contains("show")) maybeShow();
    });
    if (gresult) ob.observe(gresult, { attributes: true, attributeFilter: ["class"] });

    return () => {
      document.removeEventListener("fullscreenchange", syncFs);
      ob.disconnect();
    };
  }, [logged]);

  if (!open) return null;
  const overlay = (
    <div className="si_mask" role="dialog" aria-modal="true" aria-label="邀请注册" onClick={() => setOpen(false)}>
      <div className="si_card" onClick={(e) => e.stopPropagation()}>
        <div className="si_title">喜欢扫雷吗？那就快加入我们吧！</div>
        <div className="si_desc">
          你在线玩的成绩可以被记录，并加入排行
          <br />
          和 <span style={{ color: "#fdc61a", fontWeight: 600 }}>{players}</span> 位扫雷爱好者们一起进步！
        </div>
        <div className="si_btns">
          <button type="button" className="si_yes" onClick={() => router.push("/account/register")}>
            马上注册
          </button>
          <button type="button" className="si_no" onClick={() => setOpen(false)}>
            以后再说
          </button>
        </div>
      </div>
    </div>
  );
  return fsHost ? createPortal(overlay, fsHost) : overlay;
}
