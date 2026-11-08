import type { Metadata } from "next";
import { BotChallengeStarter } from "@/components/BotChallengeStarter";

export const metadata: Metadata = {
  title: "扫雷验证",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function BotChallengePage({ searchParams }: PageProps<"/bot/challenge">) {
  const params = await searchParams;
  const raw = typeof params.next === "string" ? params.next : "/video";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/video";
  return <BotChallengeStarter next={next} />;
}
