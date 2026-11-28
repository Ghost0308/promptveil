// Helpers for the Anthropic TypeScript SDK (@anthropic-ai/sdk 1.x).
//
// Only types come from the SDK, so this file adds no runtime dependency.

import type Anthropic from "@anthropic-ai/sdk";
import type { Detector } from "./detectors.js";
import { resolveNote } from "./note.js";
import { redact } from "./redact.js";
import {
  escapeJsonString,
  type PlaceholderFormat,
  type RestoreOptions,
  type StreamRestorer,
  Vault,
} from "./vault.js";

type Params = Anthropic.MessageCreateParams;
type Event = Anthropic.RawMessageStreamEvent;
type MapText = (text: string) => string;

export interface VeilOptions {
  /** What to look for. Defaults to the same set `redact` uses. */
  readonly detectors?: readonly Detector[];
  /** Placeholder format. Defaults to `[[TYPE_N]]`. */
  readonly format?: PlaceholderFormat;
  /** Placeholder types to put back in text. Defaults to all of them. */
  readonly textTypes?: readonly string[];
  /**
   * Placeholder types to put back in tool inputs, like `["EMAIL"]`. Defaults to
   * none, so a prompt injection can't steer a secret into a tool call.
   */
  readonly toolCallTypes?: readonly string[];
  /**
   * A note explaining the placeholders, put at the start of the system prompt
   * when something was redacted. On by default with `placeholderNote()`, since
   * without it models often remark on the placeholders or drop them. Pass a
   * string to use your own text, or `false` to leave the prompt alone.
   */
  readonly note?: boolean | string;
}

export interface VeiledRequest<P extends Params> {
  /** A redacted copy of the params. Send this instead of the original. */
  readonly params: P;
  /** The vault holding this request's values. */
  readonly vault: Vault;
  /** A copy of a response with the values put back. */
  restore(message: Anthropic.Message): Anthropic.Message;
  /**
   * Stream events with the values put back, for `create({ stream: true })` or
   * iterating `client.messages.stream()`. A placeholder split across deltas
   * comes back whole.
   */
  restoreStream(events: AsyncIterable<Event>): AsyncGenerator<Event>;
}

/**
 * Redacts a Messages API request and gives you what you need to restore the
 * reply. Every call to this makes a new vault, so redact the whole conversation
 * for each request and nothing carries over between requests or users.
 *
 * Thinking blocks are signed, so they pass through untouched both ways. The
 * model only ever saw placeholders, so they can't hold real values.
 */
export function veilMessages<P extends Params>(
  params: P,
  options: VeilOptions = {},
): VeiledRequest<P> {
  const vault = new Vault(options.format);
  const seen: string[] = [];
  mapParams(params, (text) => {
    seen.push(text);
    return text;
  });
  const context = seen.join("\n");
  let veiled = mapParams(
    params,
    (text) =>
      redact(text, {
        vault,
        context,
        ...(options.detectors === undefined ? {} : { detectors: options.detectors }),
      }).text,
  );

  const note = resolveNote(options.note, vault.format);
  if (note !== undefined && vault.size > 0) veiled = withNote(veiled, note);

  const json = params.output_config?.format?.type === "json_schema";
  const text: RestoreOptions = {
    ...(options.textTypes === undefined ? {} : { types: options.textTypes }),
    ...(json ? { encode: escapeJsonString } : {}),
  };
  const toolTypes = options.toolCallTypes ?? [];

  return {
    params: veiled,
    vault,
    restore(message) {
      if (vault.size === 0) return message;
      return {
        ...message,
        content: message.content.map((block) => restoreBlock(block, vault, text, toolTypes)),
      };
    },
    restoreStream(events) {
      return restoreEvents(events, vault, text, toolTypes);
    },
  };
}

function withNote<P extends Params>(params: P, note: string): P {
  const { system } = params;
  if (system === undefined) return { ...params, system: note };
  if (typeof system === "string") return { ...params, system: `${note}\n\n${system}` };
  return { ...params, system: [{ type: "text", text: note }, ...system] };
}

function mapParams<P extends Params>(params: P, fn: MapText): P {
  const out: P = { ...params, messages: params.messages.map((message) => mapMessage(message, fn)) };
  if (params.system !== undefined) {
    out.system =
      typeof params.system === "string"
        ? fn(params.system)
        : params.system.map((b) => mapTextBlock(b, fn));
  }
  return out;
}

function mapMessage(message: Anthropic.MessageParam, fn: MapText): Anthropic.MessageParam {
  if (message.role === "system") {
    const { content } = message;
    return {
      ...message,
      content: typeof content === "string" ? fn(content) : content.map((b) => mapTextBlock(b, fn)),
    };
  }
  const { content } = message;
  return {
    ...message,
    content: typeof content === "string" ? fn(content) : content.map((b) => mapBlock(b, fn)),
  };
}

function mapBlock(block: Anthropic.ContentBlockParam, fn: MapText): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return mapTextBlock(block, fn);
    case "document":
      return mapDocument(block, fn);
    case "search_result":
      return mapSearchResult(block, fn);
    case "tool_use":
      return { ...block, input: mapJson(block.input, fn) };
    case "tool_result": {
      const { content } = block;
      if (content === undefined) return block;
      if (typeof content === "string") return { ...block, content: fn(content) };
      return {
        ...block,
        content: content.map((item) => {
          switch (item.type) {
            case "text":
              return mapTextBlock(item, fn);
            case "document":
              return mapDocument(item, fn);
            case "search_result":
              return mapSearchResult(item, fn);
            default:
              return item;
          }
        }),
      };
    }
    default:
      // Thinking (signed), images, and the provider's own tool blocks pass through.
      return block;
  }
}

function mapTextBlock(block: Anthropic.TextBlockParam, fn: MapText): Anthropic.TextBlockParam {
  const out = { ...block, text: fn(block.text) };
  if (block.citations)
    out.citations = block.citations.map((c) => ({ ...c, cited_text: fn(c.cited_text) }));
  return out;
}

function mapSearchResult(
  block: Anthropic.SearchResultBlockParam,
  fn: MapText,
): Anthropic.SearchResultBlockParam {
  return {
    ...block,
    title: fn(block.title),
    content: block.content.map((b) => mapTextBlock(b, fn)),
  };
}

function mapDocument(
  block: Anthropic.DocumentBlockParam,
  fn: MapText,
): Anthropic.DocumentBlockParam {
  const out = { ...block };
  if (typeof block.title === "string") out.title = fn(block.title);
  if (typeof block.context === "string") out.context = fn(block.context);
  const { source } = block;
  if (source.type === "text") {
    out.source = { ...source, data: fn(source.data) };
  } else if (source.type === "content") {
    out.source = {
      ...source,
      content:
        typeof source.content === "string"
          ? fn(source.content)
          : source.content.map((item) => (item.type === "text" ? mapTextBlock(item, fn) : item)),
    };
  }
  return out;
}

/** Applies `fn` to every string value in a JSON-like value. Keys are left alone. */
function mapJson(value: unknown, fn: MapText): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapJson(item, fn));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapJson(item, fn)]));
  }
  return value;
}

function restoreBlock(
  block: Anthropic.ContentBlock,
  vault: Vault,
  text: RestoreOptions,
  toolTypes: readonly string[],
): Anthropic.ContentBlock {
  switch (block.type) {
    case "text": {
      const out = { ...block, text: vault.restore(block.text, text) };
      // The types say citations is always there, but some servers leave it out.
      if (Array.isArray(block.citations)) {
        out.citations = block.citations.map((c) => ({
          ...c,
          cited_text: vault.restore(c.cited_text, text),
        }));
      }
      return out;
    }
    case "tool_use":
      // The input is already parsed, so values go into strings directly and need no escaping.
      return {
        ...block,
        input: mapJson(block.input, (s) => vault.restore(s, { types: toolTypes })),
      };
    default:
      return block;
  }
}

async function* restoreEvents(
  events: AsyncIterable<Event>,
  vault: Vault,
  text: RestoreOptions,
  toolTypes: readonly string[],
): AsyncGenerator<Event> {
  if (vault.size === 0) {
    yield* events;
    return;
  }
  // Streamed tool input is raw JSON text, so restored values are escaped for JSON.
  const toolJson: RestoreOptions = { types: toolTypes, encode: escapeJsonString };
  const open = new Map<number, { kind: "text" | "tool"; restorer: StreamRestorer }>();

  const restorerFor = (index: number, kind: "text" | "tool") => {
    let entry = open.get(index);
    if (entry === undefined) {
      entry = { kind, restorer: vault.restorer(kind === "text" ? text : toolJson) };
      open.set(index, entry);
    }
    return entry.restorer;
  };

  function* close(index: number): Generator<Event> {
    const entry = open.get(index);
    if (entry === undefined) return;
    open.delete(index);
    const rest = entry.restorer.end();
    if (rest === "") return;
    yield {
      type: "content_block_delta",
      index,
      delta:
        entry.kind === "text"
          ? { type: "text_delta", text: rest }
          : { type: "input_json_delta", partial_json: rest },
    };
  }

  function* closeAll(): Generator<Event> {
    for (const index of [...open.keys()]) yield* close(index);
  }

  for await (const event of events) {
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          yield {
            ...event,
            content_block: { ...block, text: restorerFor(event.index, "text").push(block.text) },
          };
        } else if (block.type === "tool_use") {
          restorerFor(event.index, "tool");
          yield { ...event, content_block: restoreBlock(block, vault, text, toolTypes) };
        } else {
          yield event;
        }
        break;
      }
      case "content_block_delta": {
        const { delta } = event;
        if (delta.type === "text_delta") {
          const out = restorerFor(event.index, "text").push(delta.text);
          if (out !== "") yield { ...event, delta: { ...delta, text: out } };
        } else if (delta.type === "input_json_delta") {
          const out = restorerFor(event.index, "tool").push(delta.partial_json);
          if (out !== "") yield { ...event, delta: { ...delta, partial_json: out } };
        } else if (delta.type === "citations_delta") {
          const citation = {
            ...delta.citation,
            cited_text: vault.restore(delta.citation.cited_text, text),
          };
          yield { ...event, delta: { ...delta, citation } };
        } else {
          yield event;
        }
        break;
      }
      case "content_block_stop":
        yield* close(event.index);
        yield event;
        break;
      case "message_stop":
        yield* closeAll();
        yield event;
        break;
      default:
        yield event;
    }
  }
  yield* closeAll();
}
