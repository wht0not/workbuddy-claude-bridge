/**
 * ⚠️ 逆向适配声明（合规要求，务必阅读）
 *
 * 本网关把上游 WorkBuddy 客户端使用的私有接口（copilot.tencent.com）转录成本地
 * Anthropic Messages API。该上游接口**没有公开文档、不属于任何公开 API**，
 * 字段与行为来自对客户端的观察，可能随时变更或下线；本项目不对可用性与稳定性
 * 做任何保证。若官方提供桥接 / 开放 API，请优先使用官方方案。
 *
 * 账号模型（合规边界）：
 *   - 只使用**一个**你本人已登录的 WorkBuddy 账号（加载规则见 src/accounts.ts）；
 *   - 没有账号池、没有请求间轮换、没有自动切换；换账号只能改配置后重载；
 *   - 没有额度监控、刷取、多账号均衡等任何形式的额度套利功能。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watchFile } from "node:fs";
import { CONFIG_PATH } from "./config.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureApiKey, loadConfig } from "./config.ts";
import {
  credentialLabel,
  describeSkipped,
  loadCredential,
  refreshCredential,
  type Credential,
  type SkippedFile,
} from "./accounts.ts";
import { buildUpstreamBody, resolveModel, type AnthropicRequest } from "./anthropic.ts";
import { forwardChat } from "./upstream.ts";
import { renderPage } from "./page.ts";
import {
  AnthropicStreamTranslator,
  createSseDecoder,
  estimateTokens,
  eventsToMessage,
  formatSseEvent,
  type AnthropicEvent,
  type UpstreamChunk,
} from "./translate.ts";

const cfg = loadConfig();
const apiKey = ensureApiKey();

/**
 * 单账号状态。只在启动、配置热重载、401 刷新时变化，
 * 一次请求内恒定，不在多个账号之间轮换。
 */
let account: Credential | null = null;
let skippedFiles: SkippedFile[] = [];
let accountNote = "";
/** 401 刷新出的新令牌只活在内存里，不回写桌面端文件；重启后靠重新扫描补上。 */
let tokenOverride: { uid: string; token: string } | null = null;

function reloadAccount(): void {
  const result = loadCredential(cfg);
  let cred = result.credential;
  if (cred && tokenOverride && tokenOverride.uid === cred.uid) {
    cred = { ...cred, accessToken: tokenOverride.token };
  }
  account = cred;
  skippedFiles = result.skipped;
  accountNote = result.reason;
}

type CatalogModel = {
  id: string;
  name: string;
  credits?: string;
  descriptionZh?: string;
  maxInputTokens?: number;
};

/** 上游官方模型目录(5 分钟缓存),供 /v1/models 动态发现 */
const CATALOG_TTL = 5 * 60_000;
let catalogCache: { models: CatalogModel[]; at: number } | null = null;
async function upstreamCatalog(): Promise<{ models: CatalogModel[] }> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache;
  if (!account) return catalogCache ?? { models: [] };
  try {
    const res = await fetch(cfg.upstream.baseUrl.replace(/\/+$/, "") + "/v2/enterprises/personal/models", {
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        "user-agent": "WorkBuddy",
        "x-user-id": account.uid,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: {
        models?: {
          id?: string;
          name?: string;
          credits?: string;
          descriptionZh?: string;
          maxInputTokens?: number;
          tags?: string[];
        }[];
      };
    };
    const models = (json.data?.models ?? [])
      .filter(
        (m) =>
          m.id &&
          m.id !== "hunyuan-image-alpha" &&
          m.id !== "default" &&
          !(m.tags ?? []).some((t) => t === "text-to-image"),
      )
      .map((m) => ({
        id: m.id as string,
        name: m.name ?? (m.id as string),
        credits: m.credits,
        descriptionZh: m.descriptionZh,
        maxInputTokens: m.maxInputTokens,
      }));
    if (models.length) catalogCache = { models, at: Date.now() };
  } catch {
    // 拉取失败沿用旧缓存
  }
  return catalogCache ?? { models: [] };
}

/**
 * 上游模型 id → 桌面端合规假名(claude-haiku-<n>,匹配 ^claude-[a-z]+-\d+$)。
 * 桌面端发给网关假名,网关再反查回真实 id 转发上游。
 */
function aliasFor(upstreamId: string): string {
  // 假名必须稳定:同一真实模型 id,无论上游目录顺序怎么变、第几次发现,假名都一样。
  // 否则桌面端缓存的旧假名会失效,报 invalid_request_error(模型名路由不到)。
  // 用 id 的字符码和做序号(10-98),同 id 恒同号(纯函数,与调用顺序无关,重启不变)。
  let h = 0; for (const ch of upstreamId) h = (h * 31 + ch.charCodeAt(0)) >>> 0; const num = (h % 9890) + 10;
  return `claude-haiku-${num}`;
}
const aliasToReal = new Map<string, string>();
const realToAlias = new Map<string, string>();

async function ensureAliases(): Promise<void> {
  const { models } = await upstreamCatalog();
  for (const m of models) {
    const alias = aliasFor(m.id);
    aliasToReal.set(alias, m.id);
    realToAlias.set(m.id, alias);
  }
}

/** 配置热重载:改 config.json / config.local.json 保存即生效,无需重启(监听不依赖 cfg,永不过期) */
let reloadTimer: NodeJS.Timeout | null = null;
watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      const next = loadConfig();
      Object.assign(cfg, next);
      reloadAccount(); // accounts.select 改了要跟着重新选账号
      log("配置已热重载: 模型映射 = " + JSON.stringify(next.models.map));
    } catch (error) {
      log("配置重载失败(保留旧配置): " + String(error));
    }
  }, 300);
});

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 诊断:WB_DUMP=1 时把请求落盘 data/dump;WB_DUMP=all 时连成功请求也存。 */
const DUMP = process.env.WB_DUMP ?? "";
const dumpDir = join(process.cwd(), "data", "dump");
let dumpSeq = 0;
function dumpPair(tag: string, anthropicBody: unknown, upstreamBody: unknown, upstreamModel?: string): void {
  if (!DUMP) return;
  try {
    mkdirSync(dumpDir, { recursive: true });
    const id = `${Date.now()}-${++dumpSeq}-${tag}`;
    writeFileSync(join(dumpDir, `${id}.anthropic.json`), JSON.stringify(anthropicBody, null, 2));
    writeFileSync(join(dumpDir, `${id}.upstream.json`), JSON.stringify(upstreamBody, null, 2));
    if (upstreamModel) writeFileSync(join(dumpDir, `${id}.meta.txt`), `model=${upstreamModel}\n`);
  } catch {
    // 落盘失败不影响主流程
  }
}

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function errorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

function clientStatus(status: number): number {
  if (status === 0) return 502;
  if (status === 402) return 429; // 额度耗尽，Anthropic 侧没有对应码
  if (status < 400 || status > 599) return 502;
  return status;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { type: "error", error: { type: errorType(status), message } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体超过 32MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 同时接受 Authorization: Bearer 与 x-api-key —— cc-switch 按 env 键名决定用哪个。 */
function extractKey(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

async function serveSuccess(
  res: ServerResponse,
  upstream: Response,
  model: string,
  payload: AnthropicRequest,
  wantsStream: boolean,
): Promise<void> {
  const body = upstream.body;
  if (!body) {
    sendError(res, 502, "上游没有返回响应体");
    return;
  }

  const inputEstimate =
    estimateTokens(payload.messages) + estimateTokens(payload.system) + estimateTokens(payload.tools);
  const translator = new AnthropicStreamTranslator(model, inputEstimate);
  const decoder = createSseDecoder();
  const textDecoder = new TextDecoder();
  const reader = (body as ReadableStream<Uint8Array>).getReader();

  const pump = async (sink: (event: AnthropicEvent) => void): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of decoder(textDecoder.decode(value, { stream: true }))) {
          if (data === "[DONE]") continue;
          let chunk: UpstreamChunk;
          try {
            chunk = JSON.parse(data) as UpstreamChunk;
          } catch {
            continue;
          }
          for (const event of translator.push(chunk)) sink(event);
        }
      }
      for (const event of translator.finish()) sink(event);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 上游已关闭
      }
    }
  };

  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-wb-model-used": model,
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, cfg.keepAliveMs);

    try {
      await pump((event) => res.write(formatSseEvent(event)));
    } catch (error) {
      log("流式转发中断:", String(error));
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  const events: AnthropicEvent[] = [];
  try {
    await pump((event) => events.push(event));
  } catch (error) {
    sendError(res, 502, `读取上游流失败: ${String(error)}`);
    return;
  }

  try {
    res.setHeader("x-wb-model-used", model);
    sendJson(res, 200, eventsToMessage(events));
  } catch (error) {
    sendError(res, 500, `聚合响应失败: ${String(error)}`);
  }
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
  let payload: AnthropicRequest;
  try {
    payload = JSON.parse(raw) as AnthropicRequest;
  } catch {
    sendError(res, 400, "请求体不是合法 JSON");
    return;
  }
  if (!Array.isArray(payload.messages)) {
    sendError(res, 400, "缺少 messages 数组");
    return;
  }

  const requestedRaw = typeof payload.model === "string" && payload.model ? payload.model : cfg.models.default;
  // 桌面端动态发现发的假名(claude-xxx-n)→ 反查真实上游模型;1M 变体带 [1m] 后缀,先剥掉
  const requested = aliasToReal.get(requestedRaw.replace(/\[1m\]$/i, "")) ?? requestedRaw.replace(/\[1m\]$/i, "");
  const wantsStream = payload.stream === true;
  if (requested !== requestedRaw) log(`   假名 ${requestedRaw} → ${requested}`);

  if (!account) {
    sendError(res, 503, "本机没有可用的 WorkBuddy 账号。" + describeSkipped(skippedFiles));
    return;
  }

  // 单模型：请求什么就用什么（经 map 解析），不做回退链
  const model = resolveModel(requested, cfg);
  log(`→ ${wantsStream ? "流式" : "非流式"} model=${model} account=${credentialLabel(account)}`);

  const body = buildUpstreamBody(payload, cfg, model);
  if (DUMP) dumpPair("req", payload, body, model);

  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.on("close", onClose);

  let result = await forwardChat(cfg, account, account.accessToken, body, abort.signal);
  req.off("close", onClose);

  // 401：只用当前账号自己的 refreshToken 续期一次，再失败就报错（不换账号）
  if (!result.ok && result.status === 401 && account.refreshToken) {
    const refreshed = await refreshCredential(account, cfg);
    if (refreshed) {
      tokenOverride = { uid: refreshed.uid, token: refreshed.accessToken };
      account = refreshed;
      log(`   ${credentialLabel(account)} 令牌已刷新，重试`);
      const retryAbort = new AbortController();
      const onRetryClose = () => retryAbort.abort();
      req.on("close", onRetryClose);
      result = await forwardChat(cfg, account, account.accessToken, body, retryAbort.signal);
      req.off("close", onRetryClose);
    }
  }

  if (result.ok) {
    await serveSuccess(res, result.response, model, payload, wantsStream);
    return;
  }

  if (result.status === 401) {
    sendError(
      res,
      401,
      `账号「${credentialLabel(account)}」登录态已失效且刷新失败。请在 WorkBuddy 桌面端或 workbuddy-switch 里重新登录。`,
    );
    return;
  }

  log(`   ${model} 失败 HTTP ${result.status}`);
  sendError(res, clientStatus(result.status), result.message);
}

function friendlyReason(status: number, message: string): string {
  if (status === 0) return "连不上腾讯的服务器。检查一下网络，或者你是不是开着代理？";
  if (status === 401) return "账号的登录态过期了。去 WorkBuddy 桌面端或 workbuddy-switch 重新登录一次，然后刷新这个页面。";
  if (status === 402) return "这个账号的额度用完了。等额度恢复，或改用官方 API。";
  if (status === 403) return "账号没有权限使用这个模型。";
  if (status === 404) return "上游说这个模型不存在。检查 config.json 里的模型名。";
  if (status === 429) return "上游在限流，等一会儿再点一次。";
  if (status >= 500) return `腾讯那边出错了（HTTP ${status}），等一会儿再试。`;
  return `上游返回 HTTP ${status}：${message.slice(0, 200)}`;
}

/** 页面上的「测一下」按钮。只监听回环地址，所以不再单独鉴权。 */
async function handleTest(res: ServerResponse): Promise<void> {
  if (!account) {
    sendJson(res, 200, { ok: false, reason: "没有可用的 WorkBuddy 账号。" });
    return;
  }

  const payload: AnthropicRequest = {
    model: cfg.models.default,
    max_tokens: 300,
    messages: [{ role: "user", content: "用一句话打个招呼，证明你在正常工作。" }],
  };
  const model = resolveModel(payload.model, cfg);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const result = await forwardChat(
      cfg,
      account,
      account.accessToken,
      buildUpstreamBody(payload, cfg, model),
      controller.signal,
    );

    if (!result.ok) {
      sendJson(res, 200, { ok: false, reason: friendlyReason(result.status, result.message) });
      return;
    }

    const events: AnthropicEvent[] = [];
    const translator = new AnthropicStreamTranslator(model, 0);
    const decoder = createSseDecoder();
    const textDecoder = new TextDecoder();
    const reader = (result.response.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const data of decoder(textDecoder.decode(value, { stream: true }))) {
        if (data === "[DONE]") continue;
        try {
          for (const event of translator.push(JSON.parse(data) as UpstreamChunk)) events.push(event);
        } catch {
          // 分片不完整，跳过
        }
      }
    }
    for (const event of translator.finish()) events.push(event);

    const message = eventsToMessage(events) as {
      model?: string;
      content?: { type: string; text?: string }[];
    };
    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    sendJson(res, 200, { ok: true, text, model: message.model ?? model, ms: Date.now() - started });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      reason: controller.signal.aborted
        ? "等了两分钟还没回。这个模型这次想得太久了，可以再点一次。"
        : `测试出错：${String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderPage(cfg, apiKey));
        return;
      }

      if (method === "GET" && path === "/healthz") {
        reloadAccount();
        sendJson(res, 200, {
          ok: true,
          endpoint: `http://${cfg.host}:${cfg.port}`,
          account: account
            ? {
                label: credentialLabel(account),
                uid: account.uid.slice(0, 8),
                hasRefreshToken: Boolean(account.refreshToken),
                expiresAt: account.expiresAt,
                source: account.sourcePath,
              }
            : null,
          note: accountNote,
          skippedFiles: skippedFiles,
          models: cfg.models,
        });
        return;
      }

      if (method === "POST" && path === "/api/test") {
        await handleTest(res);
        return;
      }

      if (path.startsWith("/v1/")) {
        const provided = extractKey(req);
        if (provided !== apiKey) {
          sendError(res, 401, "API key 无效或缺失。密钥见 data/api-key.txt。");
          return;
        }
      }

      if (method === "POST" && path === "/v1/messages") {
        await handleMessages(req, res, await readBody(req));
        return;
      }

      if (method === "POST" && path === "/v1/messages/count_tokens") {
        let payload: AnthropicRequest;
        try {
          payload = JSON.parse(await readBody(req)) as AnthropicRequest;
        } catch {
          sendError(res, 400, "请求体不是合法 JSON");
          return;
        }
        const inputTokens =
          estimateTokens(payload.messages) + estimateTokens(payload.system) + estimateTokens(payload.tools);
        sendJson(res, 200, { input_tokens: inputTokens });
        return;
      }

      if (method === "GET" && path === "/v1/models") {
        await ensureAliases();
        const { models } = await upstreamCatalog();
        // 一级选择器只显示前 5 个(客户端 UI 固定),把最常用的排前面,其余进 More models
        const FEATURED = ["glm-5.3-flash", "deepseek-v4.1-flash", "kimi-k3-1", "glm-5.3", "hy3"];
        const ordered = [
          ...FEATURED.map((id) => models.find((m) => m.id === id)).filter(Boolean),
          ...models.filter((m) => !FEATURED.includes(m.id)),
        ] as CatalogModel[];
        const rows = ordered.map((m, i) => {
          const alias = realToAlias.get(m.id) ?? m.id;
          const credit = m.credits ? m.credits.replace(/\s*credits?/i, "").trim() : "";
          // tier 与假名序号同源轮换(序号 i → tier i%5),与 aliasFor 的 seq 对齐
          const TIERS = ["opus", "sonnet", "haiku", "fable", "mythos"] as const;
          const tier = TIERS[(i + 1) % TIERS.length];
          // 上游表 maxInputTokens ≥ 1M 时声明 supports_1m,客户端才会生成 1M 上下文变体(默认按 200K)
          const supports1m = typeof m.maxInputTokens === "number" && m.maxInputTokens >= 1_000_000;
          return {
            type: "model",
            id: alias,
            display_name: m.id + (credit ? ` (${credit})` : ""),
            anthropic_family_tier: tier,
            ...(supports1m ? { supports_1m: true } : {}),
            created_at: new Date(0).toISOString(),
          };
        });
        log(`← /v1/models 发现请求: 返回 ${rows.length} 个模型 (catalog=${models.length})`);
        sendJson(res, 200, {
          data: rows.length ? rows : [{ type: "model", id: cfg.models.default, display_name: cfg.models.default, created_at: new Date(0).toISOString() }],
          has_more: false,
          first_id: rows[0]?.id ?? cfg.models.default,
          last_id: rows.at(-1)?.id ?? cfg.models.default,
        });
        return;
      }

      sendError(res, 404, `未知路由 ${method} ${path}`);
    } catch (error) {
      log("请求处理异常:", String(error));
      sendError(res, 500, `网关内部错误: ${String(error)}`);
    }
  })();
});

server.on("error", (error) => {
  log(`无法监听 ${cfg.host}:${cfg.port} —— ${String(error)}`);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  reloadAccount();

  log("WorkBuddy → Anthropic 网关已启动（单账号模式）");
  log("⚠️ 上游接口为逆向适配，无公开文档，可能随时失效；如官方提供 API 请优先使用官方方案。");
  log(`  地址    http://${cfg.host}:${cfg.port}`);
  log(`  密钥    ${apiKey}`);
  log(`  密钥文件 data/api-key.txt`);
  log(`  模型    默认 ${cfg.models.default}（映射 ${Object.keys(cfg.models.map).length} 条，无回退链）`);
  if (account) {
    log(`  账号    ${credentialLabel(account)} (${account.uid.slice(0, 8)}) ← ${account.sourcePath}`);
  } else {
    log(`  账号    无可用账号`);
  }
  if (accountNote) log(`  说明    ${accountNote}`);
  for (const skip of skippedFiles) {
    log(`          ✗ ${skip.path} → ${skip.reason}`);
  }
  if (!account) log(describeSkipped(skippedFiles));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("正在退出");
    server.close(() => process.exit(0));
  });
}
