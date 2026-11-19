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
// The tool call is in the form Kimi gives it on the wire, which the id rewrite keeps.
const toolCall = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "functions.read:0", type: "function", function: { name: "read", arguments: "{}" } },
  ],
};
const toolResult = { role: "tool", tool_call_id: "functions.read:0", content: "file text" };
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

const calls = (...entries: [id: string, name: string][]) => ({
  role: "assistant",
  content: null,
  tool_calls: entries.map(([id, name]) => ({
    id,
    type: "function",
    function: { name, arguments: "{}" },
  })),
});
const result = (id: string) => ({ role: "tool", tool_call_id: id, content: "out" });

test("sends each tool call with the id Kimi writes, the same in every later request", async () => {
  const h = harness();
  const loop = [
    system,
    task,
    calls(["call-a", "read"]),
    result("call-a"),
    interrupted,
    interjection,
  ];
  const first = (await h.request({ messages: loop }))?.messages as RecordValue[];
  expect(first[2]).toEqual(calls(["functions.read:0", "read"]));
  expect(first[3]).toEqual(result("functions.read:0"));

  // The next request drops the interrupted reply, adds a turn with two calls, and carries a
  // tool result whose call is not in the request.
  const rebuilt = [
    system,
    task,
    calls(["call-a", "read"]),
    result("call-a"),
    interjection,
    calls(["call-b", "bash"], ["call-c", "read"]),
    result("call-b"),
    result("call-c"),
    result("call-gone"),
  ];
  const second = (await h.request({ messages: rebuilt }))?.messages as RecordValue[];
  expect(second.slice(0, first.length)).toEqual(first);
  expect(second.slice(first.length)).toEqual([
    calls(["functions.bash:1", "bash"], ["functions.read:2", "read"]),
    result("functions.bash:1"),
    result("functions.read:2"),
    result("call-gone"),
  ]);

  // The journal keeps OMP's ids, so a resumed process restores and renumbers the same way.
  const resumed = harness(60_000, h.journalDir);
  expect((await resumed.request({ messages: rebuilt }))?.messages).toEqual(second);

  // DeepSeek has its own template: its ids go on the wire as OMP sent them.
  const flash = harness();
  expect(await flash.request({ model: "morph-dsv41flash", messages: loop })).toBeUndefined();
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

const image = (name: string) => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${name}` },
});
const text = (value: string) => ({ type: "text", text: value });

test("gives a message its removed images back, with the system prompt it was sent with", async () => {
  const h = harness();
  const summary = { role: "user", content: [text("archive"), image("a"), image("b")] };
  const shot = { role: "user", content: [text("Attached image(s) from tool result:"), image("c")] };
  const loop = [system, summary, toolCall, toolResult, shot, answer];
  await h.request({ messages: loop });

  // A new image arrives. OMP removes the oldest one, which is in the first message, and it
  // rebuilt the system prompt in the same request.
  const rebuilt = { role: "system", content: "stable system prompt\n- xd://new_device" };
  const evicted = { role: "user", content: [text("archive"), image("b")] };
  const newShot = {
    role: "user",
    content: [text("Attached image(s) from tool result:"), image("d")],
  };
  const next = [rebuilt, evicted, toolCall, toolResult, shot, answer, newShot];
  const wire = (await h.request({ messages: next }))?.messages as RecordValue[];
  expect(wire.slice(0, 7)).toEqual([...loop, newShot]);
  expect(wire).toHaveLength(8);
  expect(wire[7].content).toContain("- xd://new_device");

  // The message that held only the removed image is gone from OMP's request; so is the
  // last image of the first message.
  const bare = { role: "user", content: [text("archive")] };
  const later = [rebuilt, bare, toolCall, toolResult, answer, newShot, nextPrompt];
  const expected = [...wire, nextPrompt];
  expect((await h.request({ messages: later }))?.messages).toEqual(expected);
  const resumed = harness(60_000, h.journalDir);
  expect((await resumed.request({ messages: later }))?.messages).toEqual(expected);
});

test("restores each image to its own message when two messages have the same text", async () => {
  const h = harness();
  const one = { role: "user", content: [text("fix this"), image("a")] };
  const two = { role: "user", content: [text("fix this"), image("b")] };
  const fixed = { role: "assistant", content: "fixed" };
  const loop = [system, task, answer, one, fixed, two, answer];
  await h.request({ messages: loop });
  // Without their images the two messages are the same; the message before each one differs.
  const bare = { role: "user", content: "fix this" };
  const rebuilt = [system, task, answer, bare, fixed, bare, answer, nextPrompt];
  const expected = [...loop, nextPrompt];
  expect((await h.request({ messages: rebuilt }))?.messages).toEqual(expected);
  const resumed = harness(60_000, h.journalDir);
  expect((await resumed.request({ messages: rebuilt }))?.messages).toEqual(expected);
});

const tool = (name: string, description: string, parameters: RecordValue = {}) => ({
  type: "function",
  function: { name, description, parameters },
});

test("keeps the first tool list on the wire and sends a change as one notice", async () => {
  const h = harness();
  const read = tool("read", "Reads a file.");
  const plan = tool("plan", "Submits a plan.");
  const sent = [read, plan];
  const loop = [system, task, toolCall, toolResult];
  await h.request({ messages: loop, tools: sent });

  // A mode ends and takes its tool away, and a description is rebuilt.
  const current = [tool("read", "Reads a file.\nReads devices too.")];
  const changed = await h.request({ messages: [...loop, answer], tools: current });
  expect(changed?.tools).toEqual(sent);
  const wire = changed?.messages as RecordValue[];
  expect(wire).toHaveLength(6);
  expect(wire[5].content).toContain("no longer available. Do not call them: plan");
  expect(wire[5].content).toContain("Reads devices too.");
  expect(h.warnings.map((warning) => warning[0])).toEqual(["Morph prefix change sent as a notice"]);

  // Later requests and a resumed process send the same bytes; the notice is not repeated.
  const later = { messages: [...loop, answer, nextPrompt], tools: current };
  const expected = [...wire, nextPrompt];
  const second = await h.request(later);
  expect(second?.tools).toEqual(sent);
  expect(second?.messages).toEqual(expected);
  const resumed = harness(60_000, h.journalDir);
  const afterResume = await resumed.request(later);
  expect(afterResume?.tools).toEqual(sent);
  expect(afterResume?.messages).toEqual(expected);

  // A request without tools gets none.
  const bare = await h.request({ messages: [...loop, answer, nextPrompt], tools: undefined });
  expect(bare?.tools).toBeUndefined();
});

test("a new tool or new parameters put the current tool list on the wire", async () => {
  const h = harness();
  const read = tool("read", "Reads a file.");
  await h.request({ messages: [system, task], tools: [read] });

  const withWrite = [read, tool("write", "Writes a file.")];
  const added = await h.request({ messages: [system, task, answer], tools: withWrite });
  expect(added?.tools).toEqual(withWrite);
  expect(added?.messages).toEqual([system, task, answer]);

  // The new list is now the one that stays.
  const removed = await h.request({ messages: [system, task, answer, nextPrompt], tools: [read] });
  expect(removed?.tools).toEqual(withWrite);

  const reshaped = [tool("read", "Reads a file.", { type: "object" })];
  const changed = await h.request({
    messages: [system, task, answer, nextPrompt],
    tools: reshaped,
  });
  expect(changed?.tools).toEqual(reshaped);
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
