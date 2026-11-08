import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import seeds from "@/core/src/lib/captcha-boards.json";
import { applyCaptchaAction, instantiateCaptchaGame, type CaptchaAction, type CaptchaGame, type CaptchaSeed } from "@/core/src/lib/captcha-board";

export const RSC_ID_COOKIE = "saolei_rsc_id";
export const RSC_PASS_COOKIE = "saolei_rsc_pass";
export const RSC_PASS_TTL_SEC = 2 * 60 * 60;
const BOARD_SEEDS = seeds as CaptchaSeed[];

type Envelope = { game: CaptchaGame; owner: string; ua: string };
type PassPayload = { typ: "rsc-pass-v1"; sub: string; ua: string; exp: number };

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("缺少环境变量 AUTH_SECRET");
  return value;
}

function key(): Buffer {
  return createHash("sha256").update(`${secret()}:minesweeper-rsc-captcha-v1`).digest();
}

function uaHash(ua: string | null): string {
  return createHash("sha256").update((ua ?? "").slice(0, 256)).digest("base64url").slice(0, 22);
}

function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function open<T>(token: string): T | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload: object, secretKey: string): string {
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", secretKey).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyPayload<T extends { exp?: number }>(token: string, secretKey: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", secretKey).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newRscId(): string {
  return randomBytes(16).toString("hex");
}

export function createChallenge(owner: string, userAgent: string | null): { token: string; game: CaptchaGame } {
  const seed = BOARD_SEEDS[randomInt(BOARD_SEEDS.length)];
  const game = instantiateCaptchaGame(seed, randomUUID(), Date.now());
  const envelope: Envelope = { game, owner, ua: uaHash(userAgent) };
  return { token: seal(envelope), game };
}

export function moveChallenge(input: {
  token: string;
  owner: string;
  userAgent: string | null;
  action: CaptchaAction;
  cell: number;
}): { token: string; game: CaptchaGame; passed: boolean } | null {
  const envelope = open<Envelope>(input.token);
  if (!envelope || envelope.owner !== input.owner || envelope.ua !== uaHash(input.userAgent)) return null;
  const game = envelope.game;
  if (game.expiresAt < Date.now()) return null;
  applyCaptchaAction(game, input.action, input.cell);
  const passed = game.won;
  return { token: passed ? "" : seal(envelope), game, passed };
}

export function publicChallenge(game: CaptchaGame) {
  return {
    width: game.width,
    height: game.height,
    board3bv: game.board3bv,
    won: game.won,
    lost: game.lost,
    moves: game.moves,
    cells: game.cells.map((state, i) => ({ state, num: state === 1 ? game.nums[i] : null })),
  };
}

export function issueRscPass(owner: string, userAgent: string | null): string {
  const payload: PassPayload = {
    typ: "rsc-pass-v1",
    sub: owner,
    ua: uaHash(userAgent),
    exp: Math.floor(Date.now() / 1000) + RSC_PASS_TTL_SEC,
  };
  return signPayload(payload, `${secret()}:rsc-pass-v1`);
}

function validSession(req: NextRequest): boolean {
  const token = req.cookies.get("saolei_session")?.value;
  if (!token) return false;
  const payload = verifyPayload<{ uid?: number; exp?: number }>(token, secret());
  return typeof payload?.uid === "number" && payload.uid > 0;
}

export function canUseRsc(req: NextRequest): boolean {
  if (validSession(req)) return true;
  const owner = req.cookies.get(RSC_ID_COOKIE)?.value;
  const token = req.cookies.get(RSC_PASS_COOKIE)?.value;
  if (!owner || !token) return false;
  const payload = verifyPayload<PassPayload>(token, `${secret()}:rsc-pass-v1`);
  return payload?.typ === "rsc-pass-v1" && payload.sub === owner && payload.ua === uaHash(req.headers.get("user-agent"));
}
