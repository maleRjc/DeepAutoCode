import { isPrivateLanHost, openRelayTunnel, resolveRelayAlias } from './ssh-relay.js';

export interface ModelListResult {
  ok: boolean;
  models: string[];
  /** URL actually queried (the relayed one when a tunnel is used). */
  endpoint: string;
  relayed: boolean;
  error?: string;
}

function normalizeBase(endpoint: string): string {
  let base = endpoint.trim().replace(/\/+$/, '');
  if (!/\/v\d+(?:[a-z0-9.-]*)?$/i.test(base)) base += '/v1';
  return base;
}

/**
 * Ask an OpenAI-compatible / Anthropic gateway which models it serves.
 * Private LAN endpoints are reached through the same SSH relay the kernel uses.
 */
export async function listProviderModels(options: {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<ModelListResult> {
  const timeoutMs = options.timeoutMs ?? 20000;
  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch {
    return { ok: false, models: [], endpoint: options.endpoint, relayed: false, error: 'Endpoint 不是合法 URL' };
  }

  const base = normalizeBase(options.endpoint);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  let relayed = false;
  let tunnel: Awaited<ReturnType<typeof openRelayTunnel>> | null = null;
  let queryBase = base;

  const alias = await resolveRelayAlias();
  if (isPrivateLanHost(host) && alias && process.env.DSH_KERNEL_NO_SSH_RELAY !== '1') {
    try {
      tunnel = await openRelayTunnel(host, port, alias, process.env.DSH_KERNEL_DEBUG === '1');
      const relayedUrl = new URL(base);
      relayedUrl.hostname = '127.0.0.1';
      relayedUrl.port = String(tunnel.localPort);
      queryBase = relayedUrl.toString().replace(/\/$/, '');
      relayed = true;
    } catch (err) {
      tunnel?.close();
      return {
        ok: false,
        models: [],
        endpoint: base,
        relayed: false,
        error: (err as Error).message,
      };
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = options.apiKey?.trim();
  if (key && key !== 'EMPTY') headers.Authorization = `Bearer ${key}`;

  try {
    const res = await fetch(`${queryBase}/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        models: [],
        endpoint: queryBase,
        relayed,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const raw = Array.isArray(json?.data)
      ? (json.data as Array<Record<string, unknown>>)
      : Array.isArray(json?.models)
        ? (json.models as Array<Record<string, unknown>>)
        : Array.isArray(json)
          ? (json as Array<Record<string, unknown>>)
          : [];
    const models = Array.from(
      new Set(
        raw
          .map((item) => (typeof item === 'string' ? item : String(item?.id ?? item?.name ?? '')))
          .filter((id) => id.trim().length > 0)
      )
    ).sort((a, b) => a.localeCompare(b));

    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        endpoint: queryBase,
        relayed,
        error: '网关没有返回任何模型（响应里没有 data[].id）',
      };
    }
    return { ok: true, models, endpoint: queryBase, relayed };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return {
      ok: false,
      models: [],
      endpoint: queryBase,
      relayed,
      error: `${(err as Error).message}${cause ? ` (${cause})` : ''}`,
    };
  } finally {
    tunnel?.close();
  }
}
