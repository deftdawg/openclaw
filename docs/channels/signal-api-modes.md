---
summary: "Implementation guide for Signal API modes (JSON-RPC vs REST)"
read_when:
  - Adding new Signal API backends
  - Modifying Signal channel internals
  - Understanding Signal module architecture
title: "Signal API Modes Implementation"
---

# Signal API Modes Implementation Guide

This document explains the architecture of the Signal channel's dual API support (JSON-RPC and REST) and all the files that need to be modified when adding or changing API backends.

## Overview

The Signal channel supports two API backends:

1. **JSON-RPC mode** (`apiMode: "jsonrpc"`) - Default. Uses signal-cli daemon with JSON-RPC over HTTP and SSE for events.
2. **REST mode** (`apiMode: "addon"`) - For signal-cli-rest-api / Home Assistant addon. Uses REST endpoints and HTTP polling.

## Files to Modify

### 1. Config Type Definitions

**File:** `src/config/types.signal.ts`

Add new config options to `SignalAccountConfig`:

```typescript
export type SignalApiMode = "jsonrpc" | "addon";

export type SignalAccountConfig = {
  apiMode?: SignalApiMode;
  pollIntervalMs?: number;  // REST mode polling interval
  // ... other fields
};
```

### 2. Zod Schema Validation

**File:** `src/config/zod-schema.providers-core.ts`

Add validation for new fields in `SignalAccountSchemaBase`:

```typescript
export const SignalAccountSchemaBase = z.object({
  apiMode: z.enum(["jsonrpc", "addon"]).optional(),
  pollIntervalMs: z.number().int().min(1000).optional(),
  // ... other fields
}).strict();
```

Without this, config validation will reject the new fields with "Invalid Config" errors.

### 3. UI Schema Labels and Help Text

**File:** `src/config/schema.ts`

Add field labels (for UI display):

```typescript
const FIELD_LABELS = {
  "channels.signal.apiMode": "Signal API Mode",
  "channels.signal.pollIntervalMs": "Signal Poll Interval (ms)",
  // ...
};
```

Add help text:

```typescript
const FIELD_HELP = {
  "channels.signal.apiMode": 'API backend: "jsonrpc" or "addon"...',
  "channels.signal.pollIntervalMs": "Poll interval in milliseconds...",
  // ...
};
```

### 4. Account Resolution

**File:** `src/signal/accounts.ts`

Expose new fields in `ResolvedSignalAccount` type and `resolveSignalAccount()`:

```typescript
export type ResolvedSignalAccount = {
  apiMode: SignalApiMode;
  pollIntervalMs: number;
  // ... other fields
};

export function resolveSignalAccount(...) {
  const apiMode: SignalApiMode = merged.apiMode ?? "jsonrpc";
  const pollIntervalMs = merged.pollIntervalMs ?? 30_000;
  return {
    apiMode,
    pollIntervalMs,
    // ...
  };
}
```

### 5. Client Implementation (Core API Calls)

**File:** `src/signal/client.ts`

This is the main abstraction point. Contains:

- `SignalRpcOptions` type with `apiMode` field
- `signalRpcRequest()` - Router that dispatches to JSON-RPC or REST
- `signalJsonRpcRequest()` - JSON-RPC implementation (POST to `/api/v1/rpc`)
- `signalRestRequest()` - REST implementation (maps method names to REST endpoints)
- `signalCheck()` - Health check with `apiMode` parameter
- `streamSignalEvents()` - Event streaming (SSE for JSON-RPC, HTTP polling for REST)

Key patterns:

```typescript
// Router pattern
export async function signalRpcRequest<T>(...) {
  const apiMode = opts.apiMode ?? "jsonrpc";
  if (apiMode === "addon") {
    return signalRestRequest<T>(method, params, opts);
  }
  return signalJsonRpcRequest<T>(method, params, opts);
}

// REST method mapping
switch (method) {
  case "send": return doPost("/v2/send", body);
  case "sendTyping": return doPut(`/v1/typing-indicator/${account}`, body);
  case "sendReaction": return doPost(`/v1/reactions/${account}`, body);
  // ...
}
```

### 6. Send Functions

**File:** `src/signal/send.ts`

Update `resolveSignalRpcContext()` to return `apiMode`:

```typescript
function resolveSignalRpcContext(...) {
  const apiMode: SignalApiMode = resolvedAccount?.apiMode ?? "jsonrpc";
  return { baseUrl, account, apiMode };
}
```

Pass `apiMode` and `account` to all `signalRpcRequest()` calls:

```typescript
await signalRpcRequest("send", params, {
  baseUrl,
  timeoutMs,
  apiMode,
  account,
});
```

### 7. Reactions

**File:** `src/signal/send-reactions.ts`

Same pattern as send.ts - update context resolver and pass `apiMode` to RPC calls.

### 8. Probe/Health Check

**File:** `src/signal/probe.ts`

Accept `apiMode` in `probeSignal()` options and pass to `signalCheck()`:

```typescript
export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  opts: SignalProbeOpts = {},
): Promise<SignalProbe> {
  const apiMode = opts.apiMode ?? "jsonrpc";
  const check = await signalCheck(baseUrl, timeoutMs, apiMode);
  // ...
}
```

### 9. SSE/Polling Reconnect Loop

**File:** `src/signal/sse-reconnect.ts`

- Add `apiMode` and `pollIntervalMs` to params
- Use different backoff policies for REST vs JSON-RPC
- Pass through to `streamSignalEvents()`

```typescript
const basePolicy = apiMode === "addon" ? REST_RECONNECT_POLICY : DEFAULT_RECONNECT_POLICY;
```

### 10. Monitor (Main Event Loop)

**File:** `src/signal/monitor.ts`

- Extract `apiMode` and `pollIntervalMs` from account
- Disable `autoStart` for REST mode (no daemon to spawn)
- Pass `apiMode` to event handler deps
- Pass `apiMode` and `pollIntervalMs` to `runSignalSseLoop()`

```typescript
const apiMode = accountInfo.apiMode;
const autoStart = apiMode === "addon" ? false : (opts.autoStart ?? ...);
```

### 11. Event Handler Types

**File:** `src/signal/monitor/event-handler.types.ts`

Add `apiMode` to `SignalEventHandlerDeps` and `fetchAttachment` params:

```typescript
export type SignalEventHandlerDeps = {
  apiMode?: "jsonrpc" | "addon";
  fetchAttachment: (params: {
    apiMode?: "jsonrpc" | "addon";
    // ...
  }) => Promise<...>;
  // ...
};
```

### 12. Event Handler Implementation

**File:** `src/signal/monitor/event-handler.ts`

Pass `apiMode` when calling `deps.fetchAttachment()`.

### 13. Signal Extension (Plugin)

**File:** `extensions/signal/src/channel.ts`

Update `probeAccount` to pass `apiMode`:

```typescript
probeAccount: async ({ account, timeoutMs }) => {
  return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs, {
    apiMode: account.apiMode,
    account: account.config.account,
  });
},
```

### 14. Documentation

**File:** `docs/channels/signal.md`

- Add section explaining the new API mode
- Document configuration options
- Add to configuration reference

## Data Flow Diagram

```
Config (openclaw.json)
    ↓
types.signal.ts (TypeScript types)
    ↓
zod-schema.providers-core.ts (validation)
    ↓
accounts.ts (resolution → ResolvedSignalAccount)
    ↓
monitor.ts (main loop, passes to deps)
    ↓
sse-reconnect.ts (reconnect loop)
    ↓
client.ts (API abstraction layer)
    ↓
REST endpoints or JSON-RPC
```

## Testing Checklist

1. Config validation accepts new fields
2. Health checks use correct endpoint (`/v1/health` vs `/api/v1/check`)
3. Messages are sent via correct method
4. Events are received (SSE vs HTTP polling)
5. Typing indicators work
6. Read receipts work
7. Reactions work
8. Attachments download correctly
9. Probe/status commands show correct info
10. UI displays the new config options

## Common Pitfalls

1. **Forgot Zod schema** → "Invalid Config" error
2. **Forgot extension update** → probes use wrong endpoint
3. **Forgot to pass `account`** → REST endpoints fail (need `{number}` in path)
4. **WebSocket vs HTTP** → REST API may use HTTP polling, not WebSocket
5. **Different response formats** → REST returns JSON directly, JSON-RPC wraps in `{result: ...}`
