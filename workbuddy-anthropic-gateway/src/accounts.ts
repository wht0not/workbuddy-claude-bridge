import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

/**
 * 单账号凭据。
 *
 * 合规边界：本模块只负责"读出一个"你本人已登录的 WorkBuddy 账号。
 * 没有账号池、没有轮询游标、没有按请求自动切换——要换账号，
 * 改 config.json 的 `accounts.select`（或本地私有配置）后重新加载即可。
 */
export type Credential = {
  uid: string;
  uin: string | null;
  nickname: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  lastRefreshTime: number | null;
  domain: string | null;
  enterpriseId: string | null;
  sourcePath: string;
};

export type SkippedFile = { path: string; reason: string };

/** 凭据加载结果：至多一个账号，外加诊断信息。 */
export type LoadResult = {
  credential: Credential | null;
  /** 扫描到的全部候选账号（含未选中的），仅供日志提示与 accounts.select 参考。 */
  available: Credential[];
  skipped: SkippedFile[];
  /** 选中/未选中的原因说明，可直接打进启动日志。 */
  reason: string;
};

function isEncrypted(v: unknown): boolean {
  if (typeof v === "string") return v.includes("wbEncrypted");
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as object).some((k) => k.toLowerCase().includes("encrypted"));
  }
  return false;
}

/** 令牌只接受裸字符串。加密包装一律判为不可用，不做任何猜测性解包。 */
function tokenString(v: unknown): string | null {
  if (isEncrypted(v)) return null;
  if (typeof v === "string") return v.trim() || null;
  return null;
}

/** 展示用字段可以宽松些：字符串、数字、或包了一层的对象。 */
function displayString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["nickname", "name", "value", "text", "uid", "uin"]) {
      const inner = displayString(o[k]);
      if (inner) return inner;
    }
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseInfo(text: string, sourcePath: string): { credential: Credential | null; reason: string } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return { credential: null, reason: "JSON 解析失败" };
  }

  const account = (json.account ?? {}) as Record<string, unknown>;
  const nestedAuth = json.auth as Record<string, unknown> | undefined;
  const auth = nestedAuth && Object.keys(nestedAuth).length > 0 ? nestedAuth : json;

  const accessToken = tokenString(auth.accessToken);
  if (!accessToken) {
    return { credential: null, reason: "accessToken 不可用（$wbEncrypted 加密包装或缺失）" };
  }

  const uid =
    displayString(account.uid) ?? displayString(auth.uid) ?? displayString(account.uin) ?? displayString(auth.uin);
  if (!uid) return { credential: null, reason: "缺少 uid" };

  const refreshExpiresAt = num(auth.refreshExpiresAt);
  if (refreshExpiresAt !== null && refreshExpiresAt < Date.now()) {
    return { credential: null, reason: "refreshToken 已过期" };
  }

  return {
    credential: {
      uid,
      uin: displayString(account.uin),
      nickname: displayString(account.nickname),
      accessToken,
      refreshToken: tokenString(auth.refreshToken),
      expiresAt: num(auth.expiresAt),
      refreshExpiresAt,
      lastRefreshTime: num(auth.lastRefreshTime),
      domain: displayString(auth.domain),
      enterpriseId: displayString(account.enterpriseId) ?? displayString(auth.enterpriseId),
      sourcePath,
    },
    reason: "",
  };
}

/**
 * workbuddy-switch（Tauri 账号切换器）的账号库 ~/.wb-switch/accounts.json。
 *
 *  它把 access_token / refresh_token 存成**明文字符串**（不是桌面端那套 $wbEncrypted 包装），
 *  而且带 refresh_token —— 比 xdpool 扫出来的 workbuddy-scan-*.info 更耐用。
 *  一份文件里可能有多个账号；这里只做解析，选出哪一个由 loadCredential 按
 *  `accounts.select` 规则决定，网关运行中不会在多个账号间轮换。
 *
 *  字段映射（实测 2026-10-12）：
 *    access_token / refresh_token   明文令牌
 *    auth_raw.accessToken / ...     同一份令牌的 Keycloak 原始字段（兜底用）
 *    uid / id                       账号 uid
 *    uin / profile_raw.uin          QQ 号
 *    nickname                       备注名
 *    domain / auth_raw.domain       x-domain 头，cn 账号是 www.codebuddy.cn
 *    enterpriseId                   企业账号才有，个人账号是 null
 *    expiresAt / expiresIn          accessToken 过期时间（绝对 ms / 相对秒）
 *    refreshExpiresAt / refreshExpiresIn  refreshToken 过期时间
 */
export function parseWbSwitch(
  text: string,
  sourcePath: string,
): { credentials: Credential[]; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { credentials: [], reason: "JSON 解析失败" };
  }

  const list: unknown[] = Array.isArray(json)
    ? json
    : ((json as { accounts?: unknown[] }).accounts ?? [json]);

  const out: Credential[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const nested = (e.auth_raw ?? {}) as Record<string, unknown>;

    const accessToken = tokenString(e.access_token ?? nested.accessToken);
    if (!accessToken) continue;

    const uid = displayString(e.uid) ?? displayString(e.id);
    if (!uid) continue;

    const createdAt = num(e.createdAt) ?? 0;
    const base = createdAt || Date.now();
    const expiresIn = num(e.expiresIn) ?? num(nested.expiresIn);
    const refreshExpiresIn = num(e.refreshExpiresIn) ?? num(nested.refreshExpiresIn);

    const refreshExpiresAt =
      num(e.refreshExpiresAt) ??
      (refreshExpiresIn !== null ? base + refreshExpiresIn * 1000 : null);
    if (refreshExpiresAt !== null && refreshExpiresAt < Date.now()) continue;

    const profile = (e.profile_raw ?? {}) as Record<string, unknown>;

    out.push({
      uid,
      uin: displayString(e.uin) ?? displayString(profile.uin),
      nickname: displayString(e.nickname) ?? displayString(profile.nickname),
      accessToken,
      refreshToken: tokenString(e.refresh_token ?? nested.refreshToken),
      expiresAt: num(e.expiresAt) ?? (expiresIn !== null ? base + expiresIn * 1000 : null),
      refreshExpiresAt,
      lastRefreshTime: createdAt || null,
      domain: displayString(e.domain) ?? displayString(nested.domain),
      enterpriseId: displayString(e.enterpriseId),
      sourcePath,
    });
  }

  if (out.length === 0) return { credentials: [], reason: "wb-switch 账号库里没有可用的明文令牌" };
  return { credentials: out, reason: "" };
}

export function credentialLabel(cred: Credential): string {
  return cred.nickname ?? cred.uin ?? cred.uid.slice(0, 8);
}

function matchesSelection(cred: Credential, select: string): boolean {
  const needle = select.trim().toLowerCase();
  if (!needle) return false;
  return (
    cred.uid.toLowerCase() === needle ||
    (cred.uin ?? "").toLowerCase() === needle ||
    (cred.nickname ?? "").toLowerCase() === needle
  );
}

/**
 * 从候选账号中选出一个。规则（写进文档，避免"猜"）：
 *   1. `accounts.select` 命中 uid / uin / 备注名（大小写不敏感）→ 用它；
 *   2. 否则取第一个带 refreshToken 的（能自动续期，更耐用）；
 *   3. 再否则取第一个。
 * 选择只在加载时发生一次，运行中不会在多个账号之间轮换或自动切换。
 */
function selectOne(
  list: Credential[],
  select: string | null | undefined,
): { chosen: Credential | null; reason: string } {
  if (list.length === 0) return { chosen: null, reason: "没有扫描到可用账号" };

  if (select && select.trim()) {
    const hit = list.find((c) => matchesSelection(c, select));
    if (hit) return { chosen: hit, reason: "" };
    return {
      chosen: null,
      reason:
        `accounts.select = "${select}" 没有命中任何账号。可用：` +
        list.map((c) => `${credentialLabel(c)} (uid=${c.uid.slice(0, 8)})`).join("、"),
    };
  }

  if (list.length > 1) {
    const durable = list.find((c) => c.refreshToken);
    if (durable) {
      return {
        chosen: durable,
        reason:
          `扫描到 ${list.length} 个账号，按规则选用带续期令牌的「${credentialLabel(durable)}」；` +
          `要固定用别的账号，在 config.json 里加 "accounts": { "select": "<uid|uin|备注名>" }`,
      };
    }
    return {
      chosen: list[0],
      reason:
        `扫描到 ${list.length} 个账号，按顺序选用「${credentialLabel(list[0])}」；` +
        `要固定用别的账号，在 config.json 里加 "accounts": { "select": "<uid|uin|备注名>" }`,
    };
  }

  return { chosen: list[0], reason: "" };
}

function readText(file: string, skipped: SkippedFile[]): string | null {
  if (!existsSync(file)) {
    skipped.push({ path: file, reason: "文件不存在" });
    return null;
  }
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch (error) {
    skipped.push({ path: file, reason: `读取失败: ${String(error)}` });
    return null;
  }
}

/**
 * 加载唯一账号。收集顺序：
 *   accounts.extraFiles → accounts.wbSwitchFiles → accounts.dirs 下的 *.info
 * 全部收集后按 selectOne 规则选一个；不提供运行中的轮换。
 */
export function loadCredential(cfg: Config): LoadResult {
  const skipped: SkippedFile[] = [];
  const available: Credential[] = [];
  const seenUid = new Set<string>();

  const consider = (cred: Credential): void => {
    if (seenUid.has(cred.uid)) return;
    seenUid.add(cred.uid);
    available.push(cred);
  };

  // 1) 显式指定的凭据文件
  for (const file of cfg.accounts.extraFiles) {
    const text = readText(file, skipped);
    if (text === null) continue;
    const { credential, reason } = parseInfo(text, file);
    if (credential) {
      consider(credential);
      continue;
    }
    const wb = parseWbSwitch(text, file);
    for (const c of wb.credentials) consider(c);
    if (wb.credentials.length === 0) skipped.push({ path: file, reason });
  }

  // 2) workbuddy-switch 账号库
  for (const file of cfg.accounts.wbSwitchFiles) {
    const text = readText(file, skipped);
    if (text === null) continue;
    const wb = parseWbSwitch(text, file);
    for (const c of wb.credentials) consider(c);
    if (wb.credentials.length === 0) skipped.push({ path: file, reason: wb.reason || "未解析出账号" });
  }

  // 3) 目录扫描 *.info
  for (const dir of cfg.accounts.dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".info")) continue;
      const file = join(dir, name);
      const text = readText(file, skipped);
      if (text === null) continue;
      const { credential, reason } = parseInfo(text, file);
      if (credential) {
        consider(credential);
        continue;
      }
      skipped.push({ path: file, reason });
    }
  }

  const { chosen, reason } = selectOne(available, cfg.accounts.select);
  return { credential: chosen, available, skipped, reason };
}

/**
 * 用 refreshToken 续期**当前这一个**账号的 accessToken。
 * 成功返回新凭据（由调用方决定是否替换内存中的账号）；失败返回 null。
 */
export async function refreshCredential(cred: Credential, cfg: Config): Promise<Credential | null> {
  const refreshToken = cred.refreshToken;
  if (!refreshToken) return null;

  const base = cfg.upstream.baseUrl.replace(/\/+$/, "");
  const url = base + cfg.upstream.refreshPath;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-refresh-token": refreshToken,
        "x-auth-refresh-source": "plugin",
        "user-agent": "WorkBuddy",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const code = num(body.code);
  if (code !== null && code !== 0 && code !== 200) return null;

  const data = (body.data ?? body) as Record<string, unknown>;
  const next = tokenString(data.accessToken);
  if (!next) return null;

  return {
    ...cred,
    accessToken: next,
    refreshToken: tokenString(data.refreshToken) ?? cred.refreshToken,
    expiresAt: num(data.expiresAt) ?? cred.expiresAt,
  };
}

/** 启动日志/健康检查里用的跳过原因说明。 */
export function describeSkipped(skipped: SkippedFile[]): string {
  if (skipped.length === 0) return " 没有扫描到凭据文件。";
  return (
    " 跳过的文件：" +
    skipped.map((s) => `\n  - ${s.path} → ${s.reason}`).join("") +
    "\n提示：桌面端 5.6.0+ 会把令牌写成 $wbEncrypted 加密包装，读不了属正常。" +
    "在 workbuddy-switch 里登录（凭据落在 ~/.wb-switch/accounts.json），或用 xdpool 插件扫码添加账号，会生成可用的明文凭据。"
  );
}
