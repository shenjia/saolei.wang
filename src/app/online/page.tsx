// 练习/排名页薄壳（2026-10-27 私有仓抽取）：实现在私有 submodule
// src/core/src/app/online/page.tsx。路由段配置必须是编译期字面量
// （Next 静态分析要求，re-export 无效），此处原样复制；页面本体走转发。
import type { Metadata } from "next";
export const metadata: Metadata = { title: "练习" };
export const dynamic = "force-dynamic";
export { default } from "@/core/src/app/online/page";
