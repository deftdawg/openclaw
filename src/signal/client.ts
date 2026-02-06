import { randomUUID } from "node:crypto";
import { resolveFetch } from "../infra/fetch.js";

export type SignalApiMode = "jsonrpc" | "rest";

export type SignalRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
  apiMode?: SignalApiMode;
  account?: string;
};

export type SignalRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type SignalRpcResponse<T> = {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
};

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed}`.replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function signalJsonRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });
  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.status === 201) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }
  const parsed = JSON.parse(text) as SignalRpcResponse<T>;
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }
  return parsed.result as T;
}

async function signalRestRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const account = opts.account ?? (params?.account as string | undefined);
  const encodedAccount = account ? encodeURIComponent(account) : "";

  const doPost = async (path: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetchWithTimeout(
      `${baseUrl}${path}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      timeoutMs,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Signal REST ${res.status}: ${text || res.statusText}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  };

  const doPut = async (path: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetchWithTimeout(
      `${baseUrl}${path}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      timeoutMs,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Signal REST ${res.status}: ${text || res.statusText}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  };

  const doDelete = async (path: string, body?: Record<string, unknown>): Promise<T> => {
    const init: RequestInit = { method: "DELETE", headers: { "Content-Type": "application/json" } };
    if (body) {
      init.body = JSON.stringify(body);
    }
    const res = await fetchWithTimeout(`${baseUrl}${path}`, init, timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Signal REST ${res.status}: ${text || res.statusText}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  };

  const doGet = async (path: string): Promise<T> => {
    const res = await fetchWithTimeout(`${baseUrl}${path}`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Signal REST ${res.status}: ${text || res.statusText}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  };

  switch (method) {
    case "version": {
      const about = await doGet("/v1/about");
      if (typeof about === "object" && about !== null && "version" in about) {
        return about;
      }
      return { version: about } as T;
    }

    case "send": {
      if (!account) {
        throw new Error("Signal REST send requires account");
      }
      const body: Record<string, unknown> = {
        number: account,
        message: params?.message ?? "",
      };
      if (params?.recipient && Array.isArray(params.recipient)) {
        body.recipients = params.recipient;
      }
      if (params?.groupId) {
        body.recipients = [`group:${params.groupId}`];
      }
      if (params?.username && Array.isArray(params.username)) {
        body.recipients = params.username.map((u) => `username:${u}`);
      }
      if (params?.attachments && Array.isArray(params.attachments)) {
        body.base64_attachments = await Promise.all(
          (params.attachments as string[]).map(async (filePath) => {
            const fs = await import("node:fs/promises");
            const buffer = await fs.readFile(filePath);
            return buffer.toString("base64");
          }),
        );
      }
      return doPost("/v2/send", body);
    }

    case "sendTyping": {
      if (!account) {
        throw new Error("Signal REST sendTyping requires account");
      }
      const body: Record<string, unknown> = {};
      if (params?.recipient && Array.isArray(params.recipient)) {
        body.recipient = params.recipient[0];
      }
      if (params?.groupId) {
        body.group_id = params.groupId;
      }
      if (params?.stop) {
        return doDelete(`/v1/typing-indicator/${encodedAccount}`, body);
      }
      return doPut(`/v1/typing-indicator/${encodedAccount}`, body);
    }

    case "sendReceipt": {
      if (!account) {
        throw new Error("Signal REST sendReceipt requires account");
      }
      const body: Record<string, unknown> = {
        receipt_type: params?.type ?? "read",
        recipient: params?.recipient?.[0] ?? params?.recipient,
        timestamp: params?.targetTimestamp,
      };
      return doPost(`/v1/receipts/${encodedAccount}`, body);
    }

    case "sendReaction": {
      if (!account) {
        throw new Error("Signal REST sendReaction requires account");
      }
      const body: Record<string, unknown> = {
        reaction: params?.emoji,
        recipient: params?.recipients?.[0] ?? params?.recipients,
        target_author: params?.targetAuthor,
        timestamp: params?.targetTimestamp,
      };
      if (params?.groupIds && Array.isArray(params.groupIds)) {
        body.group_id = params.groupIds[0];
      }
      if (params?.remove) {
        return doDelete(`/v1/reactions/${encodedAccount}`, body);
      }
      return doPost(`/v1/reactions/${encodedAccount}`, body);
    }

    case "getAttachment": {
      const attachmentId = params?.id as string | undefined;
      if (!attachmentId) {
        throw new Error("Signal REST getAttachment requires id");
      }
      const res = await fetchWithTimeout(
        `${baseUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`,
        { method: "GET" },
        timeoutMs,
      );
      if (!res.ok) {
        throw new Error(`Signal REST attachment ${res.status}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { data: buffer.toString("base64") } as T;
    }

    default:
      throw new Error(`Signal REST: unsupported method "${method}"`);
  }
}

export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions,
): Promise<T> {
  const apiMode = opts.apiMode ?? "jsonrpc";
  if (apiMode === "rest") {
    return signalRestRequest<T>(method, params, opts);
  }
  return signalJsonRpcRequest<T>(method, params, opts);
}

export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  apiMode: SignalApiMode = "jsonrpc",
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  const endpoint = apiMode === "rest" ? "/v1/health" : "/api/v1/check";
  try {
    const res = await fetchWithTimeout(`${normalized}${endpoint}`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  apiMode?: SignalApiMode;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const apiMode = params.apiMode ?? "jsonrpc";

  if (apiMode === "rest") {
    return streamSignalEventsWebSocket(params);
  }
  return streamSignalEventsSse(params);
}

async function streamSignalEventsSse(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: params.abortSignal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line === "") {
        flushEvent();
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      if (line.startsWith(":")) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }
      const [rawField, ...rest] = line.split(":");
      const field = rawField.trim();
      const rawValue = rest.join(":");
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        currentEvent.event = value;
      } else if (field === "data") {
        currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
      } else if (field === "id") {
        currentEvent.id = value;
      }
      lineEnd = buffer.indexOf("\n");
    }
  }

  flushEvent();
}

async function streamSignalEventsWebSocket(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const account = params.account;
  if (!account) {
    throw new Error("Signal REST streaming requires account");
  }

  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const wsUrl = baseUrl.replace(/^http/, "ws") + `/v1/receive/${encodeURIComponent(account)}`;

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(wsUrl);

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      ws.close();
      resolve();
    };
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {});

    ws.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      params.onEvent({ data: message });
    });

    ws.on("error", (err) => {
      params.abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    ws.on("close", () => {
      params.abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
