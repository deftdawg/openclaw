import type { BackoffPolicy } from "../infra/backoff.js";
import type { RuntimeEnv } from "../runtime.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { type SignalApiMode, type SignalSseEvent, streamSignalEvents } from "./client.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};

const REST_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

type RunSignalSseLoopParams = {
  baseUrl: string;
  account?: string;
  apiMode?: SignalApiMode;
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: Partial<BackoffPolicy>;
};

export async function runSignalSseLoop({
  baseUrl,
  account,
  apiMode,
  pollIntervalMs,
  abortSignal,
  runtime,
  onEvent,
  policy,
}: RunSignalSseLoopParams) {
  const basePolicy = apiMode === "addon" ? REST_RECONNECT_POLICY : DEFAULT_RECONNECT_POLICY;
  const reconnectPolicy = {
    ...basePolicy,
    ...policy,
  };
  let reconnectAttempts = 0;

  const logReconnectVerbose = (message: string) => {
    if (!shouldLogVerbose()) {
      return;
    }
    logVerbose(message);
  };

  while (!abortSignal?.aborted) {
    try {
      await streamSignalEvents({
        baseUrl,
        account,
        apiMode,
        pollIntervalMs,
        abortSignal,
        onEvent: (event) => {
          reconnectAttempts = 0;
          onEvent(event);
        },
      });
      if (abortSignal?.aborted) {
        return;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      logReconnectVerbose(`Signal SSE stream ended, reconnecting in ${delayMs / 1000}s...`);
      await sleepWithAbort(delayMs, abortSignal);
    } catch (err) {
      if (abortSignal?.aborted) {
        return;
      }
      runtime.error?.(`Signal SSE stream error: ${String(err)}`);
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      runtime.log?.(`Signal SSE connection lost, reconnecting in ${delayMs / 1000}s...`);
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (sleepErr) {
        if (abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}
