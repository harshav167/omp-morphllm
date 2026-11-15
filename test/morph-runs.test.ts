import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createMorphRunsExtension } from "../src/morph-runs";

type RecordValue = Record<string, unknown>;
type Handler = (event: RecordValue, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CapturedRequest = { url: string; body: RecordValue; headers: Headers };

const originalFetch = globalThis.fetch;
let requests: CapturedRequest[];

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init: RequestInit = {}) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init.body)),
      headers: new Headers(init.headers),
    });
    return Response.json({ choices: [] });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function harness(
  idleReleaseMs = 60_000,
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "morph-wire-")),
) {
  const handlers = new Map<string, Handler[]>();
  const warnings: unknown[][] = [];
  // `releases` counts started releases: a release reads the credential before it sends.
  const state = { owner: "session-a", idle: true, releases: 0 };
  const model = { provider: "morph", id: "morph-kimik31", baseUrl: "https://api.morphllm.com/v1" };
  const ctx = {
    model,
    hasUI: false,
    modelRegistry: {
      getApiKey: async () => {
        state.releases++;
        return "fixture-credential";
      },
    },
    sessionManager: { getSessionId: () => state.owner },
    isIdle: () => state.idle,
  } as unknown as ExtensionContext;

  createMorphRunsExtension({ idleReleaseMs, journalDir })({
    setLabel() {},
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    logger: {
      debug() {},
      info() {},
      warn(...args: unknown[]) {
        warnings.push(args);
      },
    },
  } as unknown as ExtensionAPI);

  const emit = async (name: string, event: RecordValue = {}, context = ctx) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = await handler({ type: name, ...event }, context);
    return result as RecordValue | undefined;
  };
  const payload = (extra: RecordValue = {}) => ({
    model: "morph-kimik31",
    messages: [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "task" },
    ],
    tools: [{ type: "function", function: { name: "read" } }],
    prompt_cache_key: "stable-cache-key",
    ...extra,
  });
  const request = (extra?: RecordValue) =>
    emit("before_provider_request", { payload: payload(extra) });

  return { ctx, state, warnings, emit, payload, request, journalDir };
}

test("tags every Kimi request of a session with one run id derived from the session", async () => {
  const h = harness();
  const first = await h.request();
  const sideRequest = await h.request({ max_tokens: 1 });
  const alias = await h.request({ model: "morph-kimik3" });
  expect(first?.run_id).toBe("omp-session-a");
  expect(sideRequest?.run_id).toBe("omp-session-a");
  expect(alias?.run_id).toBe("omp-session-a");
  expect(first?.prompt_cache_key).toBe("stable-cache-key");
});

test("leaves other models and caller-owned run fields unchanged", async () => {
  const h = harness();
  expect(await h.request({ model: "morph-dsv41flash" })).toBeUndefined();
  expect(await h.request({ run_id: "caller-run" })).toBeUndefined();
  expect(await h.request({ program_id: "caller-program" })).toBeUndefined();
  const otherProvider = { ...h.ctx, model: { provider: "kimi-code", id: "k3.1-pro" } };
  expect(
    await h.emit(
      "before_provider_request",
      { payload: h.payload() },
      otherProvider as ExtensionContext,
    ),
  ).toBeUndefined();
});

test("a rewind keeps the run; shutdown releases it with the documented final request", async () => {
  const h = harness();
  await h.request();
  await h.emit("session_tree");
  expect(requests).toHaveLength(0);
  expect((await h.request())?.run_id).toBe("omp-session-a");

  await h.emit("session_shutdown");
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://api.morphllm.com/v1/chat/completions");
  expect(requests[0].body).toEqual({
    model: "morph-kimik31",
    messages: [{ role: "user", content: "" }],
    run_id: "omp-session-a",
    run_final: true,
  });
  expect(requests[0].headers.get("authorization")).toBe("Bearer fixture-credential");
  expect(requests[0].headers.get("x-session-id")).toBe("stable-cache-key");
});

test("a branch keeps the run id of the conversation it continues", async () => {
  const h = harness();
  await h.request();
  h.state.owner = "session-b";
  await h.emit("session_branch");
  expect((await h.request())?.run_id).toBe("omp-session-a");
  expect(requests).toHaveLength(0);
});

const system = { role: "system", content: "stable system prompt" };
const task = { role: "user", content: "task" };
const toolCall = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
};
const toolResult = { role: "tool", tool_call_id: "c1", content: "file text" };
const interrupted = { role: "assistant", content: "partial reply", reasoning_content: "plan" };
const interjection = { role: "user", content: "interjection" };
const answer = { role: "assistant", content: "answer" };
const nextPrompt = { role: "user", content: "next prompt" };

test("puts an interrupted assistant reply back where it was on the wire", async () => {
  const h = harness();
  const loop = [system, task, toolCall, toolResult, interrupted, interjection];
  expect((await h.request({ messages: loop }))?.messages).toEqual(loop);

  // The next prompt arrives without the interrupted reply.
  const rebuilt = [system, task, toolCall, toolResult, interjection, answer, nextPrompt];
  const second = await h.request({ messages: rebuilt });
  expect(second?.messages).toEqual([...loop, answer, nextPrompt]);
  expect(JSON.stringify((second?.messages as unknown[]).slice(0, loop.length))).toBe(
    JSON.stringify(loop),
  );
  expect(h.warnings[0]?.[0]).toBe("Morph history restored");

  // Every later request is restored the same way, also for a model without a run id.
  const third = await h.request({ messages: [...rebuilt, answer] });
  expect(third?.messages).toEqual([...loop, answer, nextPrompt, answer]);
  const flash = { model: "morph-dsv41flash" };
  await h.request({ ...flash, messages: loop });
  const untagged = await h.request({ ...flash, messages: rebuilt });
  expect(untagged?.messages).toEqual([...loop, answer, nextPrompt]);
  expect(untagged?.run_id).toBeUndefined();
});

test("leaves a history alone when the conversation itself changed", async () => {
  const moved = harness();
  await moved.request({ messages: [system, task, answer, interjection] });
  // A move to an earlier point: the reply is gone and so is the message after it.
  const earlier = [system, task, nextPrompt];
  expect((await moved.request({ messages: earlier }))?.messages).toEqual(earlier);
  expect(moved.warnings).toHaveLength(0);

  const tools = harness();
  await tools.request({ messages: [system, task, toolCall, toolResult, interjection] });
  // A tool call cannot be put back alone.
  const withoutCall = [system, task, interjection];
  expect((await tools.request({ messages: withoutCall }))?.messages).toEqual(withoutCall);
  expect(tools.warnings).toHaveLength(0);
});

test("a resumed process restores from the session journal", async () => {
  const first = harness();
  const loop = [system, task, toolCall, toolResult, interrupted, interjection];
  const rebuilt = [system, task, toolCall, toolResult, interjection, answer, nextPrompt];
  await first.request({ messages: loop });
  await first.request({ messages: rebuilt });

  const resumed = harness(60_000, first.journalDir);
  expect((await resumed.request({ messages: rebuilt }))?.messages).toEqual([
    ...loop,
    answer,
    nextPrompt,
  ]);
});

test("gives a rewritten tool result its first form back, also after a resume", async () => {
  const h = harness();
  const loop = [system, task, toolCall, toolResult, answer];
  await h.request({ messages: loop });
  const elided = { ...toolResult, content: "[Uneventful result elided]" };
  const rebuilt = [system, task, toolCall, elided, answer, nextPrompt];
  expect((await h.request({ messages: rebuilt }))?.messages).toEqual([...loop, nextPrompt]);

  const resumed = harness(60_000, h.journalDir);
  expect((await resumed.request({ messages: rebuilt }))?.messages).toEqual([...loop, nextPrompt]);
});

test("a compaction starts a new history", async () => {
  const h = harness();
  await h.request({ messages: [system, task, toolCall, toolResult, answer] });
  await h.emit("session_compact");
  const shaken = { ...toolResult, content: "[shaken]" };
  const compacted = [system, task, toolCall, shaken, answer, nextPrompt];
  expect((await h.request({ messages: compacted }))?.messages).toEqual(compacted);
  expect(h.warnings).toHaveLength(0);
});

test("keeps the first system prompt on the wire and sends a change as one notice", async () => {
  const h = harness();
  const rebuilt = { role: "system", content: "stable system prompt\n- xd://new_device" };
  await h.request({ messages: [system, task, toolCall, toolResult] });

  const changed = await h.request({ messages: [rebuilt, task, toolCall, toolResult, answer] });
  const wire = changed?.messages as RecordValue[];
  expect(wire.slice(0, 5)).toEqual([system, task, toolCall, toolResult, answer]);
  expect(wire).toHaveLength(6);
  expect(wire[5].role).toBe("user");
  expect(wire[5].content).toContain("- xd://new_device");
  expect(wire[5].content).not.toContain("stable system prompt");

  // Later requests and a resumed process extend the same bytes; the notice is not repeated.
  const later = [rebuilt, task, toolCall, toolResult, answer, nextPrompt];
  const expected = [...wire, nextPrompt];
  expect((await h.request({ messages: later }))?.messages).toEqual(expected);
  const resumed = harness(60_000, h.journalDir);
  expect((await resumed.request({ messages: later }))?.messages).toEqual(expected);

  // Another conversation on the same model keeps its own system prompt.
  const side = [rebuilt, nextPrompt];
  expect((await h.request({ messages: side }))?.messages).toEqual(side);
});

test("after a compaction the current system prompt goes on the wire", async () => {
  const h = harness();
  const rebuilt = { role: "system", content: "rebuilt system prompt" };
  await h.request({ messages: [system, task] });
  await h.request({ messages: [system, task, answer] });
  await h.emit("session_compact");
  const compacted = [rebuilt, task, nextPrompt];
  expect((await h.request({ messages: compacted }))?.messages).toEqual(compacted);

  const resumed = harness(60_000, h.journalDir);
  expect((await resumed.request({ messages: compacted }))?.messages).toEqual(compacted);
});

test("the idle timer releases only while the agent is idle", async () => {
  jest.useFakeTimers();
  try {
    const h = harness(1000);
    h.state.idle = false;
    await h.request();
    jest.advanceTimersByTime(1500);
    expect(h.state.releases).toBe(0);
    h.state.idle = true;
    jest.advanceTimersByTime(1500);
    expect(h.state.releases).toBe(1);
    // The timer already released the run, so shutdown must not start a second release.
    await h.emit("session_shutdown");
    expect(h.state.releases).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.run_final).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("logs a prefix change and a cache miss", async () => {
  const h = harness();
  await h.request();
  await h.request({ tools: [{ type: "function", function: { name: "write" } }] });
  expect(h.warnings[0]?.[0]).toBe("Morph request prefix changed");
  expect(h.warnings[0]?.[1]).toMatchObject({ toolsChanged: true, systemChanged: false });

  const usage = (input: number, cacheRead: number) =>
    h.emit("message_end", {
      message: { role: "assistant", provider: "morph", usage: { input, cacheRead, output: 10 } },
    });
  await usage(50_000, 0);
  await usage(200, 50_000);
  expect(h.warnings).toHaveLength(1);
  await usage(50_400, 0);
  expect(h.warnings[1]?.[0]).toBe("Morph cache miss");
});
