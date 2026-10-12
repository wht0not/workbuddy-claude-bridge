/**
 * ⚠️ 逆向适配声明（合规要求，务必阅读）
 *
 * 本文件把请求转发到上游 WorkBuddy 客户端使用的私有接口
 * （copilot.tencent.com）。该接口没有公开文档、不属于任何公开 API，
 * 请求头（x-user-id / x-enterprise-id / x-domain 等）与行为来自对客户端的
 * 观察，可能随时变更或下线；本项目不对可用性与稳定性做任何保证。
 * 如腾讯提供官方桥接 / 开放 API，请优先迁移到官方方案。
 */
import type { Config } from "./config.ts";
import type { Credential } from "./accounts.ts";

export type UpstreamResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; message: string };

export function chatHeaders(cred: Credential, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "WorkBuddy",
    "x-user-id": cred.uid,
  };
  if (cred.enterpriseId) {
    headers["x-enterprise-id"] = cred.enterpriseId;
    headers["x-tenant-id"] = cred.enterpriseId;
  }
  if (cred.domain) headers["x-domain"] = cred.domain;
  return headers;
}

export function chatUrl(cfg: Config): string {
  return cfg.upstream.baseUrl.replace(/\/+$/, "") + cfg.upstream.chatPath;
}

export async function forwardChat(
  cfg: Config,
  cred: Credential,
  token: string,
  body: Record<string, unknown>,
  clientSignal?: AbortSignal,
): Promise<UpstreamResult> {
  const timeout = AbortSignal.timeout(cfg.upstream.timeoutMs);
  const signal = clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(chatUrl(cfg), {
      method: "POST",
      headers: chatHeaders(cred, token),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return { ok: false, status: 0, message: `上游连接失败: ${String(error)}` };
  }

  if (response.ok) return { ok: true, response };

  const text = await response.text().catch(() => "");
  return {
    ok: false,
    status: response.status,
    message: text.slice(0, 500) || `上游返回 HTTP ${response.status}`,
  };
}