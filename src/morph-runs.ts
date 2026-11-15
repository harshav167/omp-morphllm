import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { MORPH_BASE_URL, MORPH_PROVIDER } from "./provider";

const ENDPOINT = `${MORPH_BASE_URL}/chat/completions`;
const RELEASE_TIMEOUT_MS = 1500; // session_shutdown handlers have a 2s budget.
const IDLE_RELEASE_MS = 10 * 60_000; // Morph reclaims an idle run by itself at 15 minutes.
const CACHE_MISS_MIN_TOKENS = 16_384; // Below this an uncached input is an ordinary new turn.
const CACHE_MISS_SHARE_MARGIN = 0.25; // Cached share may fall this far below the expected share.
const MAX_HISTORIES = 3; // Sent histories kept per model: the main loop plus side requests.
const MAX_CONVERSATIONS = 8; // First-sent system prompts kept; side requests add entries.
const NOTICE_OPEN = '<system-notice source="morph-runs">';
/** How a notice from this extension starts in serialized form. */
const NOTICE_PREFIX = JSON.stringify({ role: "user", content: NOTICE_OPEN }).slice(0, -2);
/** The models whose requests carry a run id: the Kimi models of the Ultra plan. */
const RUN_MODELS: Record<string, true> = { "morph-kimik31": true, "morph-kimik3": true };

type Body = Record<string, unknown>;

type Run = {
  id: string;
  owner: string;
  model: Model;
  wireModel: string;
  cacheKey?: string;
  registry: ExtensionContext["modelRegistry"];
  closing?: Promise<void>;
};

type Quota = { limit?: number; remaining?: number; burst?: string; burstRemaining?: number };

/**
 * Messages that were on the wire and are not in OMP's request. `messages` are the exact
 * serialized messages. A reply that OMP dropped is found by its two neighbours: `after` and
 * `before` are their hashes. A notice that this extension appended is found by its position
 * `index` and the neighbour `after`; `lead` is the system prompt that the notice describes.
 */
type Drop = {
  model: string;
  after: string;
  before: string;
  messages: string[];
  index?: number;
  lead?: string[];
};

/**
 * The system messages that a conversation was first sent with. `first` is the hash of the
 * message after them, which identifies the conversation.
 */
type Frozen = { model: string; first: string; lead: string[] };

/**
 * A tool result that OMP later sent with other content. `replaced` is the hash of the later
 * form; `message` is the serialized result as it was first sent.
 */
type Rewrite = { model: string; replaced: string; message: string };

type Alignment = {
  /** Messages found in both lists, in order. */
  matched: number;
  /** Index in the previous request where the comparison stopped. */
  next: number;
  /** Leading messages of the new request that the previous request also had. */
  shared: number;
  /**
   * What to put back, in order. `previous[from..to)` goes before index `at` of the new
   * request, or replaces the message at `at` when `rewrite` is set.
   */
  edits: Array<{ at: number; from: number; to: number; rewrite: boolean }>;
};

export interface MorphRunsOptions {
  idleReleaseMs?: number;
  journalDir?: string;
}

function asBody(value: unknown): Body | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Body)
    : undefined;
}

function isMorph(model: Model | undefined): model is Model {
  return (
    model?.provider === MORPH_PROVIDER && model.baseUrl?.replace(/\/+$/, "") === MORPH_BASE_URL
  );
}

function fingerprint(value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")
    .slice(0, 16);
}

function hashOf(text: string): string {
  return Bun.hash(text).toString(36);
}

/** Hashes of the two request parts that sit before all history: system messages and tools. */
function prefixHashes(body: Body): { system: string; tools: string } {
  const system: unknown[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = asBody(message)?.role;
    if (role !== "system" && role !== "developer") break;
    system.push(message);
  }
  return { system: fingerprint(system), tools: fingerprint(body.tools ?? null) };
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
  const value = Number(headers[name]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Only an assistant message without tool calls can be put back alone: it needs no tool
 * result after it, so the restored sequence is the one Morph already accepted. A notice from
 * this extension is a plain user message and can go back too.
 */
function isRestorable(serialized: string): boolean {
  if (serialized.startsWith(NOTICE_PREFIX)) return true;
  const message = asBody(JSON.parse(serialized));
  return (
    message?.role === "assistant" &&
    !(Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  );
}

/** The call that a serialized tool result answers; undefined for any other message. */
function toolCallId(serialized: string): string | undefined {
  const message = asBody(JSON.parse(serialized));
  return message?.role === "tool" && typeof message.tool_call_id === "string"
    ? message.tool_call_id
    : undefined;
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function dropKey(drop: Drop): string {
  return drop.index === undefined
    ? `${drop.model}|${drop.after}|${drop.before}`
    : `${drop.model}|${drop.after}|@${drop.index}`;
}

/** The text of serialized system messages. */
function leadText(lead: string[]): string {
  const parts: string[] = [];
  for (const serialized of lead) {
    const content = asBody(JSON.parse(serialized))?.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = asBody(part)?.text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * A serialized user message that tells the model which system-prompt lines changed between
 * `known` and `current`; undefined when no line was added or removed.
 */
function changeNotice(known: string[], current: string[]): string | undefined {
  const before = leadText(known).split("\n");
  const after = leadText(current).split("\n");
  const beforeLines = new Set(before);
  const afterLines = new Set(after);
  const added = after.filter((line) => !beforeLines.has(line));
  const removed = before.filter((line) => !afterLines.has(line));
  if (added.length === 0 && removed.length === 0) return undefined;
  const sections = [NOTICE_OPEN, "The system instructions changed during this session."];
  if (added.length > 0) {
    sections.push("These lines are now part of the system instructions:", added.join("\n"));
  }
  if (removed.length > 0) {
    sections.push("These lines are no longer part of the system instructions:", removed.join("\n"));
  }
  sections.push("</system-notice>");
  return JSON.stringify({ role: "user", content: sections.join("\n\n") });
}

/**
 * Compares the history last sent with a new request and finds what OMP changed in the part
 * that was already sent:
 * - a tool result with other content for the same call (OMP elides some results later);
 * - a run of restorable messages that is missing, when the message that followed the run is
 *   the next message of the new request. That proves OMP removed the run and kept the
 *   conversation around it.
 * Any other difference ends the shared prefix (a rewind, a compaction, a side request).
 */
function align(previous: string[], current: string[]): Alignment {
  const edits: Alignment["edits"] = [];
  let i = 0;
  let j = 0;
  let matched = 0;
  scan: while (i < previous.length && j < current.length) {
    if (previous[i] === current[j]) {
      i++;
      j++;
      matched++;
      continue;
    }
    const call = toolCallId(previous[i]);
    if (call !== undefined && call === toolCallId(current[j])) {
      edits.push({ at: j, from: i, to: i + 1, rewrite: true });
      i++;
      j++;
      matched++;
      continue;
    }
    if (i > 0) {
      for (let k = i; k < previous.length && isRestorable(previous[k]);) {
        k++;
        if (k < previous.length && previous[k] === current[j]) {
          edits.push({ at: j, from: i, to: k, rewrite: false });
          i = k;
          continue scan;
        }
      }
    }
    break;
  }
  return { matched, next: i, shared: j, edits };
}

/**
 * Morph cache placement, wire-history stability, and cache telemetry for upstream OMP
 * (18.20.0+).
 *
 * Placement: every Kimi K3.1 request of a session carries one `run_id`, derived from the
 * session id. Morph gives `run_id` precedence over `x-session-id`, so the id must not change
 * while the session's prefix is cached: it stays the same across tool turns, retries, side
 * requests, follow-up prompts, rewinds, branches, and a resumed process. Side requests share
 * the id on purpose: they carry the same prefix and belong on the same worker.
 *
 * Wire history: Morph's cache matches a request from its first byte, so a message that was
 * sent must stay as it was. At a new prompt OMP changes the part already sent: it leaves out
 * an interrupted assistant reply and replaces some tool results (for example with
 * `[Uneventful result elided]`). Either change ends the cached prefix at that message. This
 * extension keeps the histories it sent, puts a dropped reply back at its place and gives a
 * rewritten tool result its first form back. The changes are journaled per session, so a
 * resumed process applies them too. A compaction starts a new history.
 *
 * System prompt: OMP rebuilds the system prompt during a session, for example when the list
 * of mounted devices changes. The system prompt is the first bytes of every request, so a
 * change there makes the whole request uncached. This extension keeps the system messages
 * that a conversation was first sent with, and sends the changed lines once as a
 * `<system-notice>` user message at the end of the history. The new system prompt takes
 * effect on the wire after the next compaction.
 *
 * Telemetry: each Morph response is logged with its headers (Ultra limits, backend), each
 * assistant message with its cached and uncached input tokens, and a change of the system
 * messages or tool list between two requests is logged as a prefix change.
 */
export function createMorphRunsExtension(options?: MorphRunsOptions): (pi: ExtensionAPI) => void {
  const idleReleaseMs = options?.idleReleaseMs ?? IDLE_RELEASE_MS;

  return function morphRuns(pi: ExtensionAPI): void {
    pi.setLabel("Morph Agent Runs");
    // The host's agent directory, so each profile keeps its own journals.
    const journalDir = options?.journalDir ?? path.join(pi.pi.getAgentDir(), "cache", "morph-wire");
    // Factories are rebound per session; never share state at module scope.
    let run: Run | undefined;
    let adoptOwner = false;
    let idleTimer: Timer | undefined;
    let quota: Quota = {};
    let assistantTurns = 0;
    let prefixChangedSinceUsage = false;
    let expectedCachedShare: number | undefined;
    const prefixes = new Map<string, { system: string; tools: string }>();
    const histories = new Map<string, string[][]>();
    const drops: Drop[] = [];
    const rewrites = new Map<string, string>();
    const frozen = new Map<string, string[]>();
    const noticeLeads = new Map<string, string[]>();
    const dropKeys = new Set<string>();
    const journaled = new Set<string>();
    const journalsRead = new Set<string>();

    const clearIdleTimer = (): void => {
      if (idleTimer === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    const showStatus = (ctx: ExtensionContext, text: string): void => {
      if (ctx.hasUI) ctx.ui.setStatus("morph", text);
    };

    const forget = (): void => {
      drops.length = 0;
      dropKeys.clear();
      rewrites.clear();
      frozen.clear();
      noticeLeads.clear();
      journaled.clear();
    };

    const journalFile = (owner: string): string =>
      path.join(journalDir, `${owner.replace(/[^\w-]/g, "_")}.jsonl`);

    const readJournal = (owner: string): void => {
      if (journalsRead.has(owner)) return;
      journalsRead.add(owner);
      let text: string;
      try {
        text = fs.readFileSync(journalFile(owner), "utf8");
      } catch (error) {
        if (asBody(error)?.code !== "ENOENT") {
          pi.logger.warn("Morph history journal read failed", { error: String(error) });
        }
        return;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let entry: Body | undefined;
        try {
          entry = asBody(JSON.parse(line));
        } catch {
          continue; // A line cut off by a crash; the others are still valid.
        }
        if (entry?.reset === true) {
          forget(); // A compaction: nothing journaled before this line applies any more.
          continue;
        }
        const { model, replaced, message, after, before, messages, index, first, lead } =
          entry ?? {};
        if (typeof model !== "string") continue;
        if (typeof replaced === "string" && typeof message === "string") {
          const key = `${model}|${replaced}`;
          journaled.add(`${owner}|${key}`);
          rewrites.set(key, message);
          continue;
        }
        if (typeof first === "string" && isStrings(lead)) {
          journaled.add(`${owner}|lead|${model}|${first}`);
          frozen.set(`${model}|${first}`, lead);
          continue;
        }
        if (typeof after !== "string" || typeof before !== "string" || !isStrings(messages)) {
          continue;
        }
        const drop: Drop = { model, after, before, messages };
        if (typeof index === "number") drop.index = index;
        if (isStrings(lead)) drop.lead = lead;
        const key = dropKey(drop);
        journaled.add(`${owner}|${key}`);
        if (dropKeys.has(key)) continue;
        dropKeys.add(key);
        drops.push(drop);
        if (drop.lead && messages.length > 0) noticeLeads.set(messages[0], drop.lead);
      }
    };

    const appendJournal = (owner: string, line: string): void => {
      try {
        fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(journalFile(owner), `${line}\n`, { mode: 0o600 });
      } catch (error) {
        pi.logger.warn("Morph history journal write failed", { error: String(error) });
      }
    };

    const journal = (owner: string, key: string, entry: Drop | Rewrite | Frozen): void => {
      if (journaled.has(`${owner}|${key}`)) return;
      journaled.add(`${owner}|${key}`);
      appendJournal(owner, JSON.stringify(entry));
    };

    /**
     * Returns the message list to send when it differs from `messages`, and records the list
     * as the history last sent. Messages are compared and restored in serialized form, so a
     * restored message has the bytes it had on the wire before.
     */
    const restoreHistory = (
      model: string,
      owner: string,
      messages: unknown[],
    ): unknown[] | undefined => {
      readJournal(owner);
      const objects = [...messages];
      const strings = objects.map((message) => JSON.stringify(message));
      let restored = 0;
      const insert = (at: number, serialized: string[]): void => {
        strings.splice(at, 0, ...serialized);
        objects.splice(at, 0, ...serialized.map((text): unknown => JSON.parse(text)));
        restored += serialized.length;
      };

      // The system messages stay as this conversation first sent them. A conversation is
      // known by the message after them, so a side request with its own prompt is left alone.
      let leadCount = 0;
      while (leadCount < objects.length) {
        const role = asBody(objects[leadCount])?.role;
        if (role !== "system" && role !== "developer") break;
        leadCount++;
      }
      const currentLead = strings.slice(0, leadCount);
      let knownLead: string[] | undefined;
      if (leadCount > 0 && leadCount < strings.length) {
        const first = hashOf(strings[leadCount]);
        const conversation = `${model}|${first}`;
        knownLead = frozen.get(conversation);
        frozen.delete(conversation); // Set again below, so the newest use is evicted last.
        frozen.set(conversation, knownLead ?? currentLead);
        if (frozen.size > MAX_CONVERSATIONS) {
          const oldest = frozen.keys().next().value;
          if (oldest !== undefined) frozen.delete(oldest);
        }
        if (knownLead) {
          journal(owner, `lead|${conversation}`, { model, first, lead: knownLead });
          if (!sameStrings(knownLead, currentLead)) {
            strings.splice(0, leadCount, ...knownLead);
            objects.splice(0, leadCount, ...knownLead.map((text): unknown => JSON.parse(text)));
            restored++;
          }
        }
      }

      // Known changes next: a rewritten tool result gets its first form back, then each
      // dropped run goes back where it was.
      const known = drops.filter((drop) => drop.model === model);
      if (known.length > 0 || rewrites.size > 0) {
        const hashes = strings.map(hashOf);
        for (let j = 0; j < hashes.length; j++) {
          const key = `${model}|${hashes[j]}`;
          const original = rewrites.get(key);
          if (original === undefined) continue;
          journal(owner, key, { model, replaced: hashes[j], message: original });
          strings[j] = original;
          objects[j] = JSON.parse(original);
          hashes[j] = hashOf(original);
          restored++;
        }
        // A restored run can be the neighbour that another run is found by, so repeat until
        // no run goes back.
        const pending = new Set(known);
        for (let applied = true; applied;) {
          applied = false;
          for (const drop of pending) {
            let at = -1;
            if (drop.index !== undefined) {
              if (drop.index <= hashes.length && hashes[drop.index - 1] === drop.after) {
                at = drop.index;
              }
            } else {
              for (let j = 1; j < hashes.length; j++) {
                if (hashes[j] === drop.before && hashes[j - 1] === drop.after) {
                  at = j;
                  break;
                }
              }
            }
            if (at < 0 || strings[at] === drop.messages[0]) continue;
            insert(at, drop.messages);
            hashes.splice(at, 0, ...drop.messages.map(hashOf));
            journal(owner, dropKey(drop), drop);
            pending.delete(drop);
            applied = true;
          }
        }
      }

      // New drops: compare with the histories sent before. Several are kept because a side
      // request to the same model must not replace the main loop's history.
      const sent = histories.get(model) ?? [];
      let best: { index: number; alignment: Alignment } | undefined;
      for (let index = 0; index < sent.length; index++) {
        const alignment = align(sent[index], strings);
        if (!best || alignment.matched >= best.alignment.matched) best = { index, alignment };
      }
      let shared: number | undefined;
      if (best && best.alignment.matched > 0) {
        const previous = sent[best.index];
        const { edits, next } = best.alignment;
        let offset = 0;
        let dropped = 0;
        let rewritten = 0;
        for (const edit of edits) {
          const at = edit.at + offset;
          if (edit.rewrite) {
            const original = previous[edit.from];
            const replaced = hashOf(strings[at]);
            const key = `${model}|${replaced}`;
            rewrites.set(key, original);
            journal(owner, key, { model, replaced, message: original });
            strings[at] = original;
            objects[at] = JSON.parse(original);
            restored++;
            rewritten++;
            continue;
          }
          const missing = previous.slice(edit.from, edit.to);
          insert(at, missing);
          dropped += missing.length;
          offset += missing.length;
          // A notice already has its own record, made when it was appended.
          if (missing.some((item) => noticeLeads.has(item))) continue;
          const drop: Drop = {
            model,
            after: hashOf(previous[edit.from - 1]),
            before: hashOf(previous[edit.to]),
            messages: missing,
          };
          const key = dropKey(drop);
          if (!dropKeys.has(key)) {
            dropKeys.add(key);
            drops.push(drop);
          }
          journal(owner, key, drop);
        }
        if (edits.length > 0) {
          pi.logger.warn("Morph history restored", {
            model,
            firstIndex: edits[0].at,
            dropped,
            rewritten,
          });
        }
        shared = best.alignment.shared + offset;
        if (next === previous.length) {
          sent.splice(best.index, 1);
        } else {
          // Expected for a rewind or a side request. In the main loop it names a kind of
          // change this extension does not put back yet.
          pi.logger.info("Morph history diverged", {
            model,
            sharedMessages: shared,
            previousMessages: previous.length,
            currentMessages: strings.length,
            previousRole: asBody(JSON.parse(previous[next]))?.role,
            currentRole:
              shared < strings.length ? asBody(JSON.parse(strings[shared]))?.role : undefined,
          });
        }
      }

      // The model learns of a changed system prompt from a notice at the end of the history.
      // There it costs only its own tokens. `told` is the system prompt the model knows.
      if (knownLead) {
        let told = knownLead;
        for (let j = strings.length - 1; j >= 0 && noticeLeads.size > 0; j--) {
          const lead = noticeLeads.get(strings[j]);
          if (lead) {
            told = lead;
            break;
          }
        }
        const notice = sameStrings(told, currentLead) ? undefined : changeNotice(told, currentLead);
        if (notice !== undefined) {
          const index = strings.length;
          const drop: Drop = {
            model,
            after: hashOf(strings[index - 1]),
            before: "",
            messages: [notice],
            index,
            lead: currentLead,
          };
          insert(index, [notice]);
          noticeLeads.set(notice, currentLead);
          dropKeys.add(dropKey(drop));
          drops.push(drop);
          journal(owner, dropKey(drop), drop);
          pi.logger.warn("Morph system prompt change sent as a notice", {
            model,
            index,
            noticeChars: notice.length,
          });
        }
      }

      expectedCachedShare = undefined;
      if (shared !== undefined) {
        let sharedChars = 0;
        let totalChars = 0;
        for (let index = 0; index < strings.length; index++) {
          totalChars += strings[index].length;
          if (index < shared) sharedChars += strings[index].length;
        }
        expectedCachedShare = totalChars > 0 ? sharedChars / totalChars : undefined;
      }
      sent.push(strings);
      if (sent.length > MAX_HISTORIES) sent.shift();
      histories.set(model, sent);
      return restored > 0 ? objects : undefined;
    };

    const release = (target: Run): Promise<void> => {
      if (target.closing) return target.closing;
      if (run === target) {
        run = undefined;
        clearIdleTimer();
      }
      target.closing = (async () => {
        const signal = AbortSignal.timeout(RELEASE_TIMEOUT_MS);
        try {
          const apiKey = await target.registry.getApiKey(target.model, target.owner);
          signal.throwIfAborted();
          const headers = new Headers(target.model.headers);
          if (!headers.has("authorization")) {
            if (typeof apiKey !== "string" || !apiKey || apiKey === "N/A")
              throw new Error("No Morph credential available");
            headers.set("authorization", `Bearer ${apiKey}`);
          }
          headers.set("content-type", "application/json");
          if (target.cacheKey && !headers.has("x-session-id"))
            headers.set("x-session-id", target.cacheKey);
          const response = await wrapFetchForExtraCa(globalThis.fetch)(ENDPOINT, {
            method: "POST",
            headers,
            redirect: "error",
            signal,
            body: JSON.stringify({
              model: target.wireModel,
              messages: [{ role: "user", content: "" }],
              run_id: target.id,
              run_final: true,
            }),
          });
          await response.body?.cancel();
          if (!response.ok) {
            pi.logger.warn("Morph run release rejected; Morph's idle reclaim is the backstop", {
              runId: target.id,
              status: response.status,
            });
            return;
          }
          pi.logger.debug("Morph run released", { runId: target.id });
        } catch {
          // Never log headers, credentials, or an HTTP error body that contains request data.
          pi.logger.warn("Morph run release failed; Morph's idle reclaim is the backstop", {
            runId: target.id,
          });
        }
      })();
      return target.closing;
    };

    const releaseNow = async (): Promise<void> => {
      clearIdleTimer();
      prefixes.clear();
      assistantTurns = 0;
      prefixChangedSinceUsage = false;
      adoptOwner = false;
      if (run) await release(run);
    };

    const armIdleRelease = (ctx: ExtensionContext): void => {
      clearIdleTimer();
      if (!run || idleReleaseMs <= 0) return;
      const target = run;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (run !== target) return;
        // A long tool call or a long stream is not idle: keep the run until the agent stops.
        if (ctx.isIdle()) void release(target);
        else armIdleRelease(ctx);
      }, idleReleaseMs);
      idleTimer.unref?.();
    };

    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (!isMorph(model)) return;
      const body = asBody(event.payload);
      if (!body || typeof body.model !== "string") return;
      const owner = ctx.sessionManager.getSessionId();

      let next = body;
      if (Array.isArray(body.messages)) {
        const messages = restoreHistory(body.model, owner, body.messages);
        if (messages) next = { ...next, messages };
      }

      // This reports what goes on the wire. A side request with its own system prompt or
      // tool list also reports a change: judge it by the cached tokens of the next response.
      const current = prefixHashes(next);
      const previous = prefixes.get(body.model);
      prefixes.set(body.model, current);
      if (previous && (previous.system !== current.system || previous.tools !== current.tools)) {
        prefixChangedSinceUsage = true;
        pi.logger.warn("Morph request prefix changed", {
          model: body.model,
          systemChanged: previous.system !== current.system,
          toolsChanged: previous.tools !== current.tools,
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
        });
      }

      // Caller-owned run fields, including the ThunderAgent aliases, stay as they are.
      const tagged =
        Object.hasOwn(RUN_MODELS, body.model) &&
        !("run_id" in body) &&
        !("program_id" in body) &&
        body.run_final !== true &&
        body.program_final !== true;
      if (!tagged) return next === body ? undefined : next;

      if (run && run.owner !== owner) {
        // A branch (a rewind is one) keeps its prefix up to the cut, so it keeps the run.
        if (adoptOwner) run.owner = owner;
        else void release(run);
      }
      adoptOwner = false;
      const cacheKey =
        typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined;
      if (!run) {
        run = {
          id: `omp-${owner}`,
          owner,
          model,
          wireModel: body.model,
          cacheKey,
          registry: ctx.modelRegistry,
        };
        pi.logger.debug("Morph run scheduled", { runId: run.id, model: body.model });
      } else if (cacheKey) {
        run.cacheKey = cacheKey;
      }
      armIdleRelease(ctx);
      return { ...next, run_id: run.id };
    });

    pi.on("after_provider_response", (event, ctx) => {
      if (!isMorph(ctx.model)) return;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(event.headers ?? {})) {
        if (name !== "set-cookie") headers[name] = value;
      }
      quota = {
        limit: headerNumber(headers, "x-morph-ultra-uncached-input-limit"),
        remaining: headerNumber(headers, "x-morph-ultra-uncached-input-remaining"),
        burst: headers["x-morph-ultra-uncached-input-burst"],
        burstRemaining: headerNumber(headers, "x-morph-ultra-uncached-input-burst-remaining"),
      };
      pi.logger.info("Morph response", {
        runId: run?.id,
        model: ctx.model.id,
        status: event.status,
        requestId: event.requestId,
        headers,
      });
      if (event.status === 429) {
        showStatus(ctx, `morph 429 · retry after ${headers["retry-after"] ?? "?"}s`);
      }
    });

    pi.on("message_end", (event, ctx) => {
      const message = event.message;
      if (message?.role !== "assistant" || message.provider !== MORPH_PROVIDER || !message.usage)
        return;
      const cached = message.usage.cacheRead ?? 0;
      const uncached = message.usage.input ?? 0;
      const total = cached + uncached;
      const cachedShare = total > 0 ? cached / total : 0;
      assistantTurns++;
      // The expected share is the part of the request that the previous request also had.
      // It belongs to the latest request, which is this message's request unless a side
      // request ran in between. The first response of a process has nothing to compare with.
      const cacheMiss =
        assistantTurns > 1 &&
        uncached >= CACHE_MISS_MIN_TOKENS &&
        (cached === 0 ||
          (expectedCachedShare !== undefined &&
            cachedShare < expectedCachedShare - CACHE_MISS_SHARE_MARGIN));
      const record = {
        runId: run?.id,
        model: message.model,
        cachedInputTokens: cached,
        uncachedInputTokens: uncached,
        outputTokens: message.usage.output,
        cachedShare,
        expectedCachedShare,
        prefixChanged: prefixChangedSinceUsage,
        cacheMiss,
        quota,
      };
      prefixChangedSinceUsage = false;
      if (cacheMiss) pi.logger.warn("Morph cache miss", record);
      else pi.logger.info("Morph usage", record);

      const left =
        quota.remaining === undefined ? "" : ` · ${quota.remaining}/${quota.limit ?? "?"} left`;
      showStatus(ctx, `morph ${(cachedShare * 100).toFixed(1)}% cached · ${uncached} new${left}`);
      if (cacheMiss && ctx.hasUI) {
        ctx.ui.notify(
          `Morph cache miss: ${uncached} uncached input tokens, ${cached} cached${record.prefixChanged ? " (request prefix changed)" : ""}`,
          "warning",
        );
      }
    });

    pi.on("agent_end", (_event, ctx) => armIdleRelease(ctx));

    // After a compaction OMP sends a new history on purpose. Nothing that was sent before
    // applies to it, and the current system prompt goes on the wire.
    const startNewHistory = (ctx: ExtensionContext): void => {
      if (histories.size === 0 && drops.length === 0 && rewrites.size === 0 && frozen.size === 0)
        return;
      histories.clear();
      forget();
      appendJournal(ctx.sessionManager.getSessionId(), JSON.stringify({ reset: true }));
    };
    pi.on("session_compact", (_event, ctx) => startNewHistory(ctx));
    // Some context reductions (for example shaking old tool results) end without a
    // `session_compact` event.
    pi.on("auto_compaction_end", (event, ctx) => {
      if (!event.aborted && !event.skipped && !event.errorMessage) startNewHistory(ctx);
    });

    // A branch or a tree move continues from a prefix of the same conversation, so the run
    // and the sent histories stay. A switch opens another conversation.
    pi.on("session_branch", () => {
      adoptOwner = true;
    });
    pi.on("session_switch", () => releaseNow());
    pi.on("session_shutdown", () => releaseNow());
  };
}
