import { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const MORPH_PROVIDER = "morph";
export const MORPH_BASE_URL = "https://api.morphllm.com/v1";
const API_KEYS_URL = "https://www.morphllm.com/dashboard/api-keys";

/**
 * `supportsPromptCacheKey` is in OMP's compat vocabulary (pi-catalog `compat/axes.ts`) and
 * `models.yml` accepts it, but OMP's TypeScript type does not declare it (18.20 and 19.0).
 */
type Compat = NonNullable<ProviderModelConfig["compat"]> & { supportsPromptCacheKey?: boolean };

/**
 * Morph serves open weights on its own stack. It is not Moonshot's or DeepSeek's API, so
 * every key is pinned here from Morph's documentation or from captured Morph requests, and
 * none is left to OMP's model-family defaults (which key on the model name).
 *
 * Each key changes request bytes. Changing one makes the next request of a running session
 * uncached.
 */
const COMPAT = {
  // Request shape. One system message keeps byte 0 of the request in one place.
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsMultipleSystemMessages: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  alwaysSendMaxTokens: true,
  clampOutputToModelMax: true,
  stripImageInput: false,
  streamIdleTimeoutMs: 300_000,

  // Reasoning. Morph returns `reasoning_content`; the real content is sent back unchanged,
  // never a placeholder, so an assistant turn has the same bytes every time it is sent.
  thinkingFormat: "openai",
  supportsReasoningEffort: true,
  supportsReasoningParams: true,
  omitReasoningEffort: false,
  reasoningDisableMode: "none-effort",
  reasoningContentField: "reasoning_content",
  replayReasoningContent: true,
  allowsSyntheticReasoningContentForToolCalls: false,

  // Tools. `toolSchemaFlavor: "none"` and `requiresAssistantContentForToolCalls: false`
  // switch off what OMP applies to Kimi by name: Moonshot's schema rewrite and a "."
  // inserted into assistant turns that only call tools.
  requiresAssistantContentForToolCalls: false,
  supportsToolChoice: true,
  supportsForcedToolChoice: true,
  supportsNamedToolChoice: true,
  disableReasoningOnToolChoice: false,
  disableReasoningOnForcedToolChoice: false,
  supportsStrictMode: false,
  toolSchemaFlavor: "none",

  // Cache placement. `x-session-id` asks Morph for the region and worker that hold the
  // prefix; `prompt_cache_key` asks for the region. `cache_ttl` asks for the longest
  // documented retention; Morph turns it on per model.
  promptCacheSessionHeader: "x-session-id",
  supportsPromptCacheKey: true,
  supportsPromptCacheBreakpoints: false,
  extraBody: { cache_ttl: "24h" },
} satisfies Compat;

/**
 * What the Ultra models share. Morph's catalog gives every one a 1,048,576-token window
 * and text and image input. `maxTokens` is the output reserve that OMP sends as
 * `max_tokens` on every request, so it is below the window, not Morph's catalog maximum.
 */
const ULTRA_MODEL = {
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
} satisfies Partial<ProviderModelConfig>;

/** Morph documents `none | low | medium | high | xhigh | max` for Kimi K3.1. */
const KIMI = {
  ...ULTRA_MODEL,
  thinking: {
    mode: "effort",
    efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
    defaultLevel: Effort.High,
    requiresEffort: false,
  },
  cost: { input: 2.5, output: 14, cacheRead: 0.29, cacheWrite: 0 },
  compat: COMPAT,
} satisfies Omit<ProviderModelConfig, "id" | "name">;

/**
 * Morph documents `low | high | xhigh | max` for DeepSeek V4.1 Flash, with `medium` served
 * as `high` and `minimal` as `low`. The model emits DSML tool markup.
 */
const DEEPSEEK_FLASH = {
  ...ULTRA_MODEL,
  thinking: {
    mode: "effort",
    efforts: [Effort.Low, Effort.High, Effort.XHigh, Effort.Max],
    defaultLevel: Effort.High,
    requiresEffort: false,
  },
  cost: { input: 0.12, output: 0.8, cacheRead: 0.008, cacheWrite: 0 },
  compat: {
    ...COMPAT,
    reasoningEffortMap: { minimal: "low", medium: "high" },
    streamMarkupHealingPattern: "dsml",
  } satisfies Compat,
} satisfies Omit<ProviderModelConfig, "id" | "name">;

/**
 * Morph as a provider, with the models of the Ultra plan: the entries that Morph's catalog
 * (https://www.morphllm.com/api/models/json?prices=list) marks `ultra_plan`.
 *
 * The transport is Chat Completions: Morph documents its session header, `cache_ttl`,
 * `run_id` and dynamic tools there.
 */
export const MORPH_PROVIDER_CONFIG: ProviderConfig = {
  baseUrl: MORPH_BASE_URL,
  api: "openai-completions",
  models: [
    { id: "morph-kimik31", name: "Morph Kimi K3.1", ...KIMI },
    { id: "morph-kimik3", name: "Morph Kimi K3", ...KIMI },
    { id: "morph-dsv41flash", name: "Morph DeepSeek V4.1 Flash", ...DEEPSEEK_FLASH },
    { id: "morph-dsv41flash-1017", name: "Morph DeepSeek V4.1 Flash 1017", ...DEEPSEEK_FLASH },
  ],
  // `/login morph`: OMP stores the key that this returns in its credential store.
  oauth: {
    name: "Morph",
    async login(callbacks) {
      callbacks.onAuth({
        url: API_KEYS_URL,
        instructions: "Create or copy a Morph API key, then paste it here.",
      });
      const answer = await callbacks.onPrompt({
        message: "Morph API key",
        placeholder: "sk-...",
        secret: true,
      });
      const key = answer.trim().replace(/^bearer\s+/i, "");
      if (!key) throw new Error("No Morph API key entered");

      callbacks.onProgress?.("Validating API key...");
      // Morph's model list answers 200 for any key, so it cannot validate one. A chat
      // request without messages generates nothing: Morph answers 401 for a key that it
      // does not accept and 400 for one that it does.
      const response = await (callbacks.fetch ?? fetch)(`${MORPH_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "morph-kimik31", messages: [] }),
        signal: callbacks.signal,
      });
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new Error("Morph did not accept this API key");
      }
      return key;
    },
  },
};
