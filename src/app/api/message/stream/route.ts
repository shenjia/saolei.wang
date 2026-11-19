// 站内信未读数 SSE 推送（2026-10-29）：替代全站 30s 轮询（单窗口 2,880 req/日）。
// Next 16 App Router 流式响应原生支持，无需 custom server；蓝绿单 active 进程，
// 进程内 messageBus（lib/message-bus.ts）覆盖全部写点。多窗口去重在客户端
// hook 层（Web Locks 选主，见 useUnreadMessages.ts），本端点每窗口仅 leader 连接。
import { NextRequest } from "next/server";
import { getSession, reissueSessionParentDomain } from "@/lib/auth";
import { getUnreadCount } from "@/lib/message";
import { messageBus } from "@/lib/message-bus";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("请先登录", { status: 401 });
  // cookie 迁移补种从 30s 轮询挪到握手时执行一次（原每发都跑幂等检查）
  await reissueSessionParentDomain();
  const uid = Number(session.uid);

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          return false; // 流已断，触发 cleanup
        }
      };
      const push = async () => {
        try {
          const unread = await getUnreadCount(uid);
          send(`data: ${JSON.stringify({ unread })}\n\n`);
        } catch {
          // 查库瞬时失败静默，等下一个信号；客户端 focus 刷新兜底
        }
      };
      const onUser = (id: number) => {
        if (id === uid) void push();
      };
      const onAll = () => void push();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        messageBus.off("user", onUser);
        messageBus.off("all", onAll);
        try {
          controller.close();
        } catch {
          // 已关
        }
      };

      // 握手先发当前值，客户端立即可渲染（不等下一次写点事件）
      await push();
      messageBus.on("user", onUser);
      messageBus.on("all", onAll);
      // 25s 心跳注释行：过 nginx proxy_read_timeout（默认 60s），
      // 以 ":" 开头不触发 EventSource onmessage
      heartbeat = setInterval(() => {
        if (!send(": ping\n\n")) cleanup();
      }, 25_000);
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // nginx 关闭 proxy_buffering，SSE 直通
      Connection: "keep-alive",
    },
  });
}
