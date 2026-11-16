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
/** What OMP leaves in a user message from which it removed every image. */
const IMAGE_OMITTED = "[image omitted: provider image limit]";
/** How the tool list starts as the last item of a first-sent prefix. */
const TOOLS_ITEM = "tools:";
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
 * What a conversation was first sent with before its history. `lead` holds the serialized
 * system messages and, as its last item, the tool list (`TOOLS_ITEM` and the serialized
 * list). `first` is the hash of the message after the system messages, which identifies the
 * conversation.
 */
type Frozen = { model: string; first: string; lead: string[] };

/**
 * A message that OMP later sent in another form: a tool result with other content, or a user
 * message without some of its images. `replaced` is the hash of the later form, `after` the
 * hash of the message before it on the wire (empty for the first message of a conversation),
 * and `message` the serialized message as it was first sent.
 */
type Rewrite = { model: string; replaced: string; after?: string; message: string };

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
 * Only two kinds of message can be put back alone. An assistant message without tool calls
 * needs no tool result after it, so the restored sequence is the one Morph already accepted.
 * A user message with an image is one that OMP removed together with its last image. A notice
 * from this extension is a plain user message and can go back too.
 */
function isRestorable(serialized: string): boolean {
  if (serialized.startsWith(NOTICE_PREFIX)) return true;
  const message = asBody(JSON.parse(serialized));
  if (message?.role === "user") return (userParts(serialized)?.images.length ?? 0) > 0;
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

/** The text and the other parts (images) of a serialized user message. */
function userParts(serialized: string): { text: string; images: string[] } | undefined {
  const message = asBody(JSON.parse(serialized));
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") {
    return { text: message.content === IMAGE_OMITTED ? "" : message.content, images: [] };
  }
  if (!Array.isArray(message.content)) return undefined;
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of message.content) {
    const body = asBody(part);
    const text = body?.type === "text" ? body.text : undefined;
    if (typeof text !== "string") images.push(JSON.stringify(part));
    else if (text !== IMAGE_OMITTED) texts.push(text);
  }
  return { text: texts.join("\n"), images };
}

/**
 * True when `current` is the user message `previous` without some of its images. OMP sends
 * a limited number of images per request and removes the oldest ones past the limit.
 */
function lostImages(previous: string, current: string): boolean {
  const before = userParts(previous);
  const after = userParts(current);
  if (!before || !after || before.text !== after.text) return false;
  if (after.images.length >= before.images.length) return false;
  let kept = 0;
  for (const image of before.images) if (after.images[kept] === image) kept++;
  return kept === after.images.length;
}

type ToolEntry = { parameters: string; description: string };

/** The tools of a Chat Completions list by name; undefined when an entry has no name. */
function toolEntries(tools: unknown[]): Map<string, ToolEntry> | undefined {
  const entries = new Map<string, ToolEntry>();
  for (const tool of tools) {
    const fn = asBody(asBody(tool)?.function);
    if (typeof fn?.name !== "string") return undefined;
    entries.set(fn.name, {
      parameters: JSON.stringify(fn.parameters ?? null),
      description: typeof fn.description === "string" ? fn.description : "",
    });
  }
  return entries;
}

/**
 * True when the list `sent` can stay on the wire for a request with the tools `current`: it
 * declares every current tool with the same parameters. A tool that `current` lacks stays
 * declared; a notice tells the model that it is gone.
 */
function declaresAll(sent: unknown[], current: unknown[]): boolean {
  const known = toolEntries(sent);
  const now = toolEntries(current);
  if (!known || !now) return false;
  for (const [name, tool] of now) {
    if (known.get(name)?.parameters !== tool.parameters) return false;
  }
  return true;
}

/** The system messages and the tool list of a first-sent prefix. */
function splitPrefix(lead: string[]): { system: string[]; tools?: unknown[] } {
  const last = lead.at(-1);
  if (!last?.startsWith(TOOLS_ITEM)) return { system: lead };
  const tools: unknown = JSON.parse(last.slice(TOOLS_ITEM.length));
  return { system: lead.slice(0, -1), tools: Array.isArray(tools) ? tools : [] };
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

/** The journal key of a conversation's first-sent prefix; a new tool list is a new record. */
function leadKey(conversation: string, lead: string[]): string {
  return `lead|${conversation}|${hashOf(lead.at(-1) ?? "")}`;
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

/** The lines that only one of two texts has. */
function lineChanges(before: string, after: string): { added: string[]; removed: string[] } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const inBefore = new Set(beforeLines);
  const inAfter = new Set(afterLines);
  return {
    added: afterLines.filter((line) => !inBefore.has(line)),
    removed: beforeLines.filter((line) => !inAfter.has(line)),
  };
}

/**
 * A serialized user message that tells the model what changed between the prefixes `known`
 * and `current`: system-prompt lines, tools that went away or came back, and tool
 * descriptions. Undefined when nothing changed.
 */
function changeNotice(known: string[], current: string[]): string | undefined {
  const was = splitPrefix(known);
  const now = splitPrefix(current);
  const sections = [NOTICE_OPEN];
  const system = lineChanges(leadText(was.system), leadText(now.system));
  if (system.added.length > 0 || system.removed.length > 0) {
    sections.push("The system instructions changed during this session.");
    if (system.added.length > 0) {
      sections.push(
        "These lines are now part of the system instructions:",
        system.added.join("\n"),
      );
    }
    if (system.removed.length > 0) {
      sections.push(
        "These lines are no longer part of the system instructions:",
        system.removed.join("\n"),
      );
    }
  }
  const before = was.tools && toolEntries(was.tools);
  const after = now.tools && toolEntries(now.tools);
  if (before && after) {
    const gone = [...before.keys()].filter((name) => !after.has(name));
    const back = [...after.keys()].filter((name) => !before.has(name));
    if (gone.length > 0) {
      sections.push(`These tools are no longer available. Do not call them: ${gone.join(", ")}`);
    }
    if (back.length > 0) sections.push(`These tools are available: ${back.join(", ")}`);
    for (const [name, tool] of after) {
      const old = before.get(name);
      if (!old || old.description === tool.description) continue;
      const lines = lineChanges(old.description, tool.description);
      sections.push(`The description of the tool \`${name}\` changed.`);
      if (lines.added.length > 0) {
        sections.push("These lines are now part of it:", lines.added.join("\n"));
      }
      if (lines.removed.length > 0) {
        sections.push("These lines are no longer part of it:", lines.removed.join("\n"));
      }
    }
  }
  if (sections.length === 1) return undefined;
  sections.push("</system-notice>");
  return JSON.stringify({ role: "user", content: sections.join("\n\n") });
}

/**
 * Compares the history last sent with a new request and finds what OMP changed in the part
 * that was already sent:
 * - a tool result with other content for the same call (OMP elides some results later);
 * - a user message without some of its images (OMP removes the oldest images past its limit);
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
    if (
      (call !== undefined && call === toolCallId(current[j])) ||
      lostImages(previous[i], current[j])
    ) {
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
 * sent must stay as it was. OMP changes the part already sent: at a new prompt it leaves out
 * an interrupted assistant reply and replaces some tool results (for example with
 * `[Uneventful result elided]`), and when the model reads an image it removes the oldest
 * images past its per-request limit, which are the frames of the compaction summary first.
 * Each change ends the cached prefix at that message. This extension keeps the histories it
 * sent, puts a dropped message back at its place and gives a changed message its first form
 * back. The changes are journaled per session, so a resumed process applies them too. A
 * compaction starts a new history.
 *
 * System prompt and tools: OMP rebuilds the system prompt and the tool list during a
 * session, for example when the list of mounted devices changes or a mode adds a tool. Both
 * are the first bytes of every request, so a change there makes the whole request uncached.
 * This extension keeps the system messages and the tool list that a conversation was first
 * sent with, and sends what changed once as a `<system-notice>` user message at the end of
 * the history. A tool that is new, or has new parameters, must be declared: then the current
 * tool list goes on the wire. The new system prompt takes effect on the wire after the next
 * compaction.
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
          const key =
            typeof after === "string" ? `${model}|${replaced}|${after}` : `${model}|${replaced}`;
          journaled.add(`${owner}|${key}`);
          rewrites.set(key, message);
          continue;
        }
        if (typeof first === "string" && isStrings(lead)) {
          journaled.add(`${owner}|${leadKey(`${model}|${first}`, lead)}`);
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
     * Returns the message list and the tool list to send where they differ from the
     * request's own, and records the message list as the history last sent. Messages are
     * compared and restored in serialized form, so a restored message has the bytes it had
     * on the wire before.
     */
    const restoreHistory = (
      model: string,
      owner: string,
      messages: unknown[],
      tools: unknown,
    ): { messages?: unknown[]; tools?: unknown[] } => {
      readJournal(owner);
      const objects = [...messages];
      const strings = objects.map((message) => JSON.stringify(message));
      const sent = histories.get(model) ?? [];
      let restored = 0;
      const insert = (at: number, serialized: string[]): void => {
        strings.splice(at, 0, ...serialized);
        objects.splice(at, 0, ...serialized.map((text): unknown => JSON.parse(text)));
        restored += serialized.length;
      };

      let leadCount = 0;
      while (leadCount < objects.length) {
        const role = asBody(objects[leadCount])?.role;
        if (role !== "system" && role !== "developer") break;
        leadCount++;
      }
      /** Gives the message at `at` its first form back and keeps the pair for later requests. */
      const putBack = (at: number, original: string): void => {
        const replaced = hashOf(strings[at]);
        const after = at <= leadCount ? "" : hashOf(strings[at - 1]);
        const key = `${model}|${replaced}|${after}`;
        rewrites.set(key, original);
        journal(owner, key, { model, replaced, after, message: original });
        strings[at] = original;
        objects[at] = JSON.parse(original);
        restored++;
      };

      // The message after the system messages identifies the conversation, so it gets its
      // first form back before the conversation is looked up.
      if (leadCount > 0 && leadCount < strings.length) {
        const current = strings[leadCount];
        const original =
          rewrites.get(`${model}|${hashOf(current)}|`) ??
          sent
            .map((history) => history[leadCount])
            .find((previous) => previous !== undefined && lostImages(previous, current));
        if (original !== undefined) putBack(leadCount, original);
      }

      // The system messages and the tool list stay as this conversation first sent them. A
      // side request with its own prompt is another conversation and is left alone. A request
      // without tools keeps none.
      const currentTools = Array.isArray(tools) && tools.length > 0 ? tools : undefined;
      const currentToolsItem =
        currentTools === undefined ? undefined : TOOLS_ITEM + JSON.stringify(currentTools);
      const currentLead = strings.slice(0, leadCount);
      if (currentToolsItem !== undefined) currentLead.push(currentToolsItem);
      let knownLead: string[] | undefined;
      let wireTools: unknown[] | undefined;
      let toolsAdopted = false;
      if (leadCount > 0 && leadCount < strings.length) {
        const conversation = `${model}|${hashOf(strings[leadCount])}`;
        knownLead = frozen.get(conversation);
        if (knownLead && currentTools && currentToolsItem !== undefined) {
          const known = splitPrefix(knownLead);
          if (known.tools && declaresAll(known.tools, currentTools)) {
            if (knownLead.at(-1) !== currentToolsItem) wireTools = known.tools;
          } else {
            knownLead = [...known.system, currentToolsItem];
            toolsAdopted = true;
          }
        }
        frozen.delete(conversation); // Set again below, so the newest use is evicted last.
        frozen.set(conversation, knownLead ?? currentLead);
        if (frozen.size > MAX_CONVERSATIONS) {
          const oldest = frozen.keys().next().value;
          if (oldest !== undefined) frozen.delete(oldest);
        }
        if (knownLead) {
          journal(owner, leadKey(conversation, knownLead), {
            model,
            first: hashOf(strings[leadCount]),
            lead: knownLead,
          });
          const system = splitPrefix(knownLead).system;
          if (!sameStrings(system, strings.slice(0, leadCount))) {
            strings.splice(0, leadCount, ...system);
            objects.splice(0, leadCount, ...system.map((text): unknown => JSON.parse(text)));
            restored++;
          }
        }
      }

      // Known changes: a changed message gets its first form back and each dropped run goes
      // back where it was. A restored message can be the neighbour that another change is
      // found by, so repeat until nothing goes back.
      const pending = new Set(drops.filter((drop) => drop.model === model));
      const applyKnown = (): void => {
        if (pending.size === 0 && rewrites.size === 0) return;
        const hashes = strings.map(hashOf);
        for (let applied = true; applied;) {
          applied = false;
          for (let j = 0; rewrites.size > 0 && j < hashes.length; j++) {
            const after = j <= leadCount ? "" : hashes[j - 1];
            const original =
              rewrites.get(`${model}|${hashes[j]}|${after}`) ??
              rewrites.get(`${model}|${hashes[j]}`);
            if (original === undefined) continue;
            putBack(j, original);
            hashes[j] = hashOf(original);
            applied = true;
          }
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
      };
      const closest = (): { index: number; alignment: Alignment } | undefined => {
        let best: { index: number; alignment: Alignment } | undefined;
        for (let index = 0; index < sent.length; index++) {
          const alignment = align(sent[index], strings);
          if (!best || alignment.matched >= best.alignment.matched) best = { index, alignment };
        }
        return best && best.alignment.matched > 0 ? best : undefined;
      };

      // New changes: compare with the histories sent before. Several are kept because a side
      // request to the same model must not replace the main loop's history. A message that
      // goes back can bring a known change into reach, so compare again after each round.
      applyKnown();
      let best = closest();
      while (best && best.alignment.edits.length > 0) {
        const previous = sent[best.index];
        const { edits } = best.alignment;
        let offset = 0;
        let dropped = 0;
        let rewritten = 0;
        for (const edit of edits) {
          const at = edit.at + offset;
          if (edit.rewrite) {
            putBack(at, previous[edit.from]);
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
        pi.logger.warn("Morph history restored", {
          model,
          firstIndex: edits[0].at,
          dropped,
          rewritten,
        });
        applyKnown();
        best = closest();
      }
      let shared: number | undefined;
      if (best) {
        const previous = sent[best.index];
        const { next } = best.alignment;
        shared = best.alignment.shared;
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

      // The model learns of a changed system prompt or tool list from a notice at the end of
      // the history. There it costs only its own tokens. `told` is the prefix the model knows.
      if (knownLead) {
        let told = knownLead;
        for (let j = strings.length - 1; j >= 0 && noticeLeads.size > 0; j--) {
          const lead = noticeLeads.get(strings[j]);
          if (lead) {
            told = lead;
            break;
          }
        }
        // The model sees a tool list that went on the wire, so no notice describes it.
        if (toolsAdopted && currentToolsItem !== undefined) {
          told = [...splitPrefix(told).system, currentToolsItem];
        }
        // A request without tools says nothing about the tools the model knows.
        const toldTools = told.at(-1)?.startsWith(TOOLS_ITEM) ? told.at(-1) : undefined;
        const now =
          currentToolsItem === undefined && toldTools !== undefined
            ? [...currentLead, toldTools]
            : currentLead;
        const notice = sameStrings(told, now) ? undefined : changeNotice(told, now);
        if (notice !== undefined) {
          const index = strings.length;
          const drop: Drop = {
            model,
            after: hashOf(strings[index - 1]),
            before: "",
            messages: [notice],
            index,
            lead: now,
          };
          insert(index, [notice]);
          noticeLeads.set(notice, now);
          dropKeys.add(dropKey(drop));
          drops.push(drop);
          journal(owner, dropKey(drop), drop);
          pi.logger.warn("Morph prefix change sent as a notice", {
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
      return { messages: restored > 0 ? objects : undefined, tools: wireTools };
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
        const restored = restoreHistory(body.model, owner, body.messages, body.tools);
        if (restored.messages) next = { ...next, messages: restored.messages };
        if (restored.tools) next = { ...next, tools: restored.tools };
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
