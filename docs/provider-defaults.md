# Provider defaults

[`src/provider.ts`](../src/provider.ts) holds every setting. Each value comes from Morph's documentation or from captured Morph requests. No value comes from the defaults that OMP applies by model name.

A change to a setting changes request bytes. The next request of a running session is then uncached.

## Provider

| Setting | Value |
|---|---|
| Provider ID | `morph` |
| Base URL | `https://api.morphllm.com/v1` |
| API | `openai-completions` |
| Credential | `/login`, stored by OMP |
| Output tokens reserved for each request | 131,072 |

Morph documents the session header, `cache_ttl`, `run_id`, and dynamic tools on Chat Completions.

## Request settings

| Group | Settings | Reason |
|---|---|---|
| Prefix | `supportsMultipleSystemMessages: false`, `supportsDeveloperRole: false`, `supportsStore: false` | The request starts with one system message. |
| Output | `maxTokensField: max_tokens`, `alwaysSendMaxTokens: true`, `clampOutputToModelMax: true` | Each request carries the same field with the same value. |
| Reasoning | `thinkingFormat: openai`, `supportsReasoningEffort: true`, `supportsReasoningParams: true`, `reasoningDisableMode: none-effort` | Morph accepts `reasoning_effort`, and `none` disables reasoning. |
| Reasoning replay | `reasoningContentField: reasoning_content`, `replayReasoningContent: true`, `allowsSyntheticReasoningContentForToolCalls: false` | OMP sends an assistant turn with its real reasoning. The bytes of the turn stay the same in each request. |
| Tools | `toolSchemaFlavor: none`, `requiresAssistantContentForToolCalls: false`, `supportsStrictMode: false` | OMP does not apply Moonshot's schema rewrite. OMP does not add `"."` to a turn that only calls tools. |
| Tool choice | `supportsToolChoice: true`, `supportsForcedToolChoice: true`, `supportsNamedToolChoice: true` | Morph accepts `tool_choice`. |
| Placement | `promptCacheSessionHeader: x-session-id`, `supportsPromptCacheKey: true` | Morph routes `x-session-id` to the region and the worker that hold the prefix. Morph routes `prompt_cache_key` to the region. |
| Retention | `extraBody.cache_ttl: "24h"` | `24h` is the longest tier that Morph documents. Morph enables `cache_ttl` for each model separately. |
| Streams | `supportsUsageInStreaming: true`, `streamIdleTimeoutMs: 300000` | The last stream event carries the token usage. A throttled request can wait minutes for its first token. |
| Images | `stripImageInput: false` | The models accept images. |

## DeepSeek V4.1 Flash

| Setting | Value | Reason |
|---|---|---|
| `reasoningEffortMap` | `minimal: low`, `medium: high` | Morph serves `medium` as `high` and `minimal` as `low`. |
| `streamMarkupHealingPattern` | `dsml` | The model writes tool calls as DSML markup. |
