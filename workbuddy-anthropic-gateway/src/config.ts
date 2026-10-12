import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(here, "..");
export const DATA_DIR = join(ROOT, "data");
export const CONFIG_PATH = join(ROOT, "config.json");
/** 本地私有配置：不进 git（见 .gitignore），覆盖 config.json 的同名字段。 */
export const LOCAL_CONFIG_PATH = join(ROOT, "config.local.json");

export type ModelsConfig = {
  default: string;
  map: Record<string, string>;
};

export type UpstreamConfig = {
  baseUrl: string;
  chatPath: string;
  refreshPath: string;
  timeoutMs: number;
};

export type AccountsConfig = {
  dirs: string[];
  extraFiles: string[];
  /** workbuddy-switch 的账号库（~/.wb-switch/accounts.json），明文令牌 + 带 refresh_token */
  wbSwitchFiles: string[];
  /**
   * 手动指定用哪个账号（uid / uin / 备注名，大小写不敏感）。
   * 不填则按文档规则自动选一个；填了就只认这一个。
   * 合规边界：这里是唯一允许的"换账号"入口——改配置后重载，运行中不轮换。
   */
  select: string | null;
};

export type Config = {
  port: number;
  host: string;
  models: ModelsConfig;
  upstream: UpstreamConfig;
  accounts: AccountsConfig;
  keepAliveMs: number;
  minMaxTokens: number;
};

/** 展开 %APPDATA% 这类 Windows 环境变量，以及开头的 ~。
 *  ~ 依次试 USERPROFILE（Windows）和 HOME（Linux / WSL），网关两边都能跑。 */
export function expandEnv(input: string): string {
  let out = input;
  const tilde = out.match(/^~(?=[\\/]|$)/);
  if (tilde) {
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (home) out = home + out.slice(1);
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    return v ?? whole;
  });
  return out;
}

const DEFAULTS: Config = {
  port: 8789,
  host: "127.0.0.1",
  models: {
    default: "glm-5.3-flash",
    map: {
      "claude-opus": "glm-5.3-flash",
      "claude-sonnet": "glm-5.3-flash",
      "claude-haiku": "deepseek-v4.1-flash",
    },
  },
  upstream: {
    baseUrl: "https://copilot.tencent.com",
    chatPath: "/v2/chat/completions",
    refreshPath: "/v2/plugin/auth/token/refresh",
    timeoutMs: 300_000,
  },
  accounts: {
    dirs: [
      "%APPDATA%/CodeBuddyExtension/Data/Public/auth",
      "%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth",
    ],
    extraFiles: [],
    wbSwitchFiles: ["~/.wb-switch/accounts.json"],
    select: null,
  },
  keepAliveMs: 15_000,
  minMaxTokens: 8192,
};

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

/** 仅合并普通对象一层（配置就是 models/upstream/accounts 三个子对象 + 标量）。 */
function mergeSection<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const current = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      current && typeof current === "object" && !Array.isArray(current)
    ) {
      out[k] = { ...(current as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function readJson(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Partial<Config>;
}

export function loadConfig(): Config {
  // config.json（可入库）打底，config.local.json（已 gitignore）覆盖——
  // 敏感/本机信息放后者，前者保持通用默认值。
  const raw = mergeSection(readJson(CONFIG_PATH), readJson(LOCAL_CONFIG_PATH));

  const models = raw.models ?? ({} as Partial<ModelsConfig>);
  const upstream = raw.upstream ?? ({} as Partial<UpstreamConfig>);
  const accounts = raw.accounts ?? ({} as Partial<AccountsConfig>);

  return {
    port: pick(raw.port, DEFAULTS.port),
    host: pick(raw.host, DEFAULTS.host),
    models: {
      default: pick(models.default, DEFAULTS.models.default),
      map: pick(models.map, DEFAULTS.models.map),
    },
    upstream: {
      baseUrl: pick(upstream.baseUrl, DEFAULTS.upstream.baseUrl),
      chatPath: pick(upstream.chatPath, DEFAULTS.upstream.chatPath),
      refreshPath: pick(upstream.refreshPath, DEFAULTS.upstream.refreshPath),
      timeoutMs: pick(upstream.timeoutMs, DEFAULTS.upstream.timeoutMs),
    },
    accounts: {
      dirs: pick(accounts.dirs, DEFAULTS.accounts.dirs).map(expandEnv),
      extraFiles: pick(accounts.extraFiles, DEFAULTS.accounts.extraFiles).map(expandEnv),
      wbSwitchFiles: pick(accounts.wbSwitchFiles, DEFAULTS.accounts.wbSwitchFiles).map(expandEnv),
      select: pick(accounts.select, DEFAULTS.accounts.select),
    },
    keepAliveMs: pick(raw.keepAliveMs, DEFAULTS.keepAliveMs),
    minMaxTokens: pick(raw.minMaxTokens, DEFAULTS.minMaxTokens),
  };
}

const API_KEY_PATH = () => join(DATA_DIR, "api-key.txt");

/** 首次运行自动生成网关密钥；同时接受 Authorization: Bearer 与 x-api-key */
export function ensureApiKey(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = API_KEY_PATH();
  if (existsSync(p)) {
    const existing = readFileSync(p, "utf8").trim();
    if (existing) return existing;
  }
  const key = "sk-wb-" + randomBytes(24).toString("hex");
  writeFileSync(p, key + "\n", "utf8");
  return key;
}
