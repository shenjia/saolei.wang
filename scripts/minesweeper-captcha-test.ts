import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

async function main() {
  process.env.AUTH_SECRET = "captcha-test-secret";
  const bot = await import("../src/lib/bot-challenge");
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../src/proxy");
  const { captcha3BV, captchaNumbers, instantiateCaptchaGame } = await import("../src/core/src/lib/captcha-board");
  const seeds = (await import("../src/core/src/lib/captcha-boards.json")).default;
  assert.equal(seeds.length, 100);
  const distinct = new Set<string>();
  for (const seed of seeds) {
    assert.equal(seed.mines.length, 64);
    assert.equal(seed.nums.length, 64);
    assert.equal(seed.mines.reduce((sum, mine) => sum + mine, 0), 10);
    assert.ok(seed.mines.every((mine) => mine === 0 || mine === 1));
    assert.deepEqual(seed.nums, captchaNumbers(seed.mines));
    assert.equal(seed.board3bv, captcha3BV(seed.mines, seed.nums));
    assert.ok(seed.board3bv < 4);
    assert.equal(seed.mines[seed.opening], 0);
    const initial = instantiateCaptchaGame(seed, "seed-test", Date.now());
    assert.ok(initial.openedSafe >= 8);
    assert.ok(initial.openedSafe < 54);
    assert.equal(initial.won, false);
    distinct.add(seed.mines.join(""));
  }
  assert.equal(distinct.size, 100);
  const owner = "0123456789abcdef0123456789abcdef";
  const ua = "captcha-test-browser";
  let { token, game } = bot.createChallenge(owner, ua);
  assert.ok(token.length > 100);
  assert.equal(game.board3bv < 4, true);
  assert.equal(bot.publicChallenge(game).cells.length, 64);
  assert.equal("mines" in bot.publicChallenge(game), false);
  assert.equal(bot.moveChallenge({ token, owner: "bad", userAgent: ua, action: "open", cell: 0 }), null);
  assert.equal(bot.moveChallenge({ token, owner, userAgent: "wrong-browser", action: "open", cell: 0 }), null);
  const tampered = `${token.slice(0, -2)}${token.endsWith("aa") ? "bb" : "aa"}`;
  assert.equal(bot.moveChallenge({ token: tampered, owner, userAgent: ua, action: "open", cell: 0 }), null);

  let passed = false;
  for (let cell = 0; cell < 64; cell++) {
    if (game.mines[cell] || game.cells[cell] === 1) continue;
    const result = bot.moveChallenge({ token, owner, userAgent: ua, action: "open", cell });
    assert.ok(result);
    token = result.token;
    game = result.game;
    if (result.passed) {
      passed = true;
      break;
    }
  }
  assert.equal(passed, true);
  assert.equal(game.won, true);
  assert.equal(game.openedSafe, 54);
  assert.equal(token, "");

  const pass = bot.issueRscPass(owner, ua);
  const authed = new NextRequest("https://saolei.wang/video?_rsc=test", {
    headers: { "user-agent": ua, cookie: `${bot.RSC_ID_COOKIE}=${owner}; ${bot.RSC_PASS_COOKIE}=${pass}`, rsc: "1" },
  });
  assert.equal(bot.canUseRsc(authed), true);
  assert.equal((await proxy(authed)).status, 200);
  const wrongUa = new NextRequest("https://saolei.wang/video?_rsc=test", {
    headers: { "user-agent": "other", cookie: `${bot.RSC_ID_COOKIE}=${owner}; ${bot.RSC_PASS_COOKIE}=${pass}`, rsc: "1" },
  });
  assert.equal(bot.canUseRsc(wrongUa), false);
  const anonymous = new NextRequest("https://saolei.wang/video?_rsc=test", { headers: { rsc: "1" } });
  assert.equal(bot.canUseRsc(anonymous), false);
  const anonymousRes = await proxy(anonymous);
  assert.equal(anonymousRes.status, 403);
  assert.equal(anonymousRes.headers.get("x-saolei-challenge"), "minesweeper");
  const api = new NextRequest("https://saolei.wang/api/online/ranked/pb?_rsc=test");
  assert.equal((await proxy(api)).status, 200);
  const filteredDocument = new NextRequest("https://saolei.wang/video?author=123&3bv=20", { headers: { host: "saolei.wang", "x-forwarded-proto": "https" } });
  const filteredResponse = await proxy(filteredDocument);
  assert.equal(filteredResponse.status, 307);
  assert.ok(filteredResponse.headers.get("location")?.startsWith("https://saolei.wang/bot/challenge?next="));
  assert.equal((await proxy(new NextRequest("https://saolei.wang/video"))).status, 200);
  const passedDocument = new NextRequest("https://saolei.wang/video?author=123&3bv=20", {
    headers: { "user-agent": ua, cookie: `${bot.RSC_ID_COOKIE}=${owner}; ${bot.RSC_PASS_COOKIE}=${pass}` },
  });
  assert.equal((await proxy(passedDocument)).status, 200);

  const b64 = (value: string) => Buffer.from(value).toString("base64url");
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ uid: 1, username: "test", role: 10, exp: Math.floor(Date.now() / 1000) + 60 }));
  const sig = createHmac("sha256", process.env.AUTH_SECRET).update(`${header}.${body}`).digest("base64url");
  const session = new NextRequest("https://saolei.wang/video?_rsc=test", {
    headers: { cookie: `saolei_session=${header}.${body}.${sig}` },
  });
  assert.equal(bot.canUseRsc(session), true);
  const forgedSession = new NextRequest("https://saolei.wang/video?_rsc=test", {
    headers: { cookie: `saolei_session=${header}.${body}.forged` },
  });
  assert.equal(bot.canUseRsc(forgedSession), false);

  for (let i = 0; i < 120; i++) {
    const retry = bot.createChallenge(owner, ua);
    assert.equal(retry.game.board3bv < 4, true);
  }
  console.log("captcha security tests passed: 100 seeds, tamper/owner/UA rejection, server-side win, pass, signed session, API bypass, unlimited retry");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
