// Middleware for the Vercel AI SDK (language model spec v4, AI SDK 7).
//
// Only types come from @ai-sdk/provider, so this file adds no runtime dependency.

import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
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

export interface PromptveilMiddlewareOptions {
  /** What to look for. Defaults to the same set `redact` uses. */
  readonly detectors?: readonly Detector[];
  /** Placeholder format. Defaults to `[[TYPE_N]]`. */
  readonly format?: PlaceholderFormat;
  /** Placeholder types to put back in text and reasoning. Defaults to all of them. */
  readonly textTypes?: readonly string[];
  /**
   * Placeholder types to put back inside tool call arguments, like `["EMAIL"]`.
   * Defaults to none, so a prompt injection can't steer a secret into a tool call.
   */
  readonly toolCallTypes?: readonly string[];
  /**
   * A system message explaining the placeholders, added on calls where something
   * was redacted. On by default with `placeholderNote()`, since without it models
   * often remark on the placeholders or drop them. Pass a string to use your own
   * text, or `false` to leave the prompt alone.
   */
  readonly note?: boolean | string;
}

/**
 * AI SDK middleware that redacts everything the model would see and puts the
 * values back in what it returns, streamed or not. Use it with `wrapLanguageModel`.
 *
 * Each call gets its own vault. The whole conversation is redacted on every
 * call, so placeholders stay consistent within a call and nothing is shared
 * between calls, users or requests.
 */
export function promptveilMiddleware(
  options: PromptveilMiddlewareOptions = {},
): LanguageModelV4Middleware {
  const vaults = new WeakMap<LanguageModelV4CallOptions, Vault>();
  const tool: RestoreOptions = { types: options.toolCallTypes ?? [], encode: escapeJsonString };

  return {
    specificationVersion: "v4",

    async transformParams({ params }) {
      const vault = new Vault(options.format);
      const seen: string[] = [];
      mapPrompt(params.prompt, (text) => {
        seen.push(text);
        return text;
      });
      const context = seen.join("\n");
      const prompt = mapPrompt(
        params.prompt,
        (text) =>
          redact(text, {
            vault,
            context,
            ...(options.detectors === undefined ? {} : { detectors: options.detectors }),
          }).text,
      );
      const note = resolveNote(options.note, vault.format);
      if (note !== undefined && vault.size > 0) {
        prompt.unshift({ role: "system", content: note });
      }
      const transformed = { ...params, prompt };
      vaults.set(transformed, vault);
      return transformed;
    },

    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      const vault = vaults.get(params);
      if (vault === undefined || vault.size === 0) return result;
      const text = textOptions(options.textTypes, params.responseFormat?.type === "json");
      const restored = {
        ...result,
        content: result.content.map((part) => restoreContent(part, vault, text, tool)),
      };
      if (result.structuredOutputText !== undefined) {
        restored.structuredOutputText = vault.restore(result.structuredOutputText, {
          ...text,
          encode: escapeJsonString,
        });
      }
      return restored;
    },

    async wrapStream({ doStream, params }) {
      const result = await doStream();
      const vault = vaults.get(params);
      if (vault === undefined || vault.size === 0) return result;
      const text = textOptions(options.textTypes, params.responseFormat?.type === "json");
      return { ...result, stream: result.stream.pipeThrough(restoreParts(vault, text, tool)) };
    },
  };
}

function textOptions(types: readonly string[] | undefined, json: boolean): RestoreOptions {
  return {
    ...(types === undefined ? {} : { types }),
    ...(json ? { encode: escapeJsonString } : {}),
  };
}

type MapText = (text: string) => string;

/** A copy of `prompt` with `fn` applied to every piece of text the model reads. */
function mapPrompt(prompt: LanguageModelV4Prompt, fn: MapText): LanguageModelV4Prompt {
  return prompt.map((message) => mapMessage(message, fn));
}

function mapMessage(message: LanguageModelV4Message, fn: MapText): LanguageModelV4Message {
  switch (message.role) {
    case "system":
      return { ...message, content: fn(message.content) };
    case "user":
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "text" ? { ...part, text: fn(part.text) } : mapFile(part, fn),
        ),
      };
    case "assistant":
      return {
        ...message,
        content: message.content.map((part) => {
          switch (part.type) {
            case "text":
            case "reasoning":
              return { ...part, text: fn(part.text) };
            case "file":
              return mapFile(part, fn);
            case "tool-call":
              return { ...part, input: mapJson(part.input, fn) };
            case "tool-result":
              return { ...part, output: mapOutput(part.output, fn) };
            default:
              return part;
          }
        }),
      };
    case "tool":
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type === "tool-result") return { ...part, output: mapOutput(part.output, fn) };
          return part.reason === undefined ? part : { ...part, reason: fn(part.reason) };
        }),
      };
  }
}

function mapFile(part: LanguageModelV4FilePart, fn: MapText): LanguageModelV4FilePart {
  return part.data.type === "text"
    ? { ...part, data: { ...part.data, text: fn(part.data.text) } }
    : part;
}

function mapOutput(
  output: LanguageModelV4ToolResultOutput,
  fn: MapText,
): LanguageModelV4ToolResultOutput {
  switch (output.type) {
    case "text":
    case "error-text":
      return { ...output, value: fn(output.value) };
    case "json":
    case "error-json":
      return { ...output, value: mapJson(output.value, fn) as typeof output.value };
    case "execution-denied":
      return output.reason === undefined ? output : { ...output, reason: fn(output.reason) };
    case "content":
      return {
        ...output,
        value: output.value.map((item) => {
          if (item.type === "text") return { ...item, text: fn(item.text) };
          if (item.type === "file" && item.data.type === "text") {
            return { ...item, data: { ...item.data, text: fn(item.data.text) } };
          }
          return item;
        }),
      };
  }
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

function restoreContent(
  part: LanguageModelV4Content,
  vault: Vault,
  text: RestoreOptions,
  tool: RestoreOptions,
): LanguageModelV4Content {
  switch (part.type) {
    case "text":
    case "reasoning":
      return { ...part, text: vault.restore(part.text, text) };
    case "tool-call":
      return { ...part, input: vault.restore(part.input, tool) };
    default:
      return part;
  }
}

type DeltaKind = "text" | "reasoning" | "tool-input";

/** Restores placeholders in a stream of parts, holding back only partial placeholders. */
function restoreParts(
  vault: Vault,
  text: RestoreOptions,
  tool: RestoreOptions,
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const open = new Map<string, { kind: DeltaKind; id: string; restorer: StreamRestorer }>();
  const toolText: RestoreOptions = tool.types === undefined ? {} : { types: tool.types };

  const restorer = (kind: DeltaKind, id: string, options: RestoreOptions) => {
    const key = `${kind}:${id}`;
    let entry = open.get(key);
    if (entry === undefined) {
      entry = { kind, id, restorer: vault.restorer(options) };
      open.set(key, entry);
    }
    return entry.restorer;
  };

  const close = (
    kind: DeltaKind,
    id: string,
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  ) => {
    const key = `${kind}:${id}`;
    const entry = open.get(key);
    if (entry === undefined) return;
    open.delete(key);
    const rest = entry.restorer.end();
    if (rest !== "") controller.enqueue({ type: `${kind}-delta`, id, delta: rest });
  };

  const closeAll = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) => {
    for (const entry of [...open.values()]) close(entry.kind, entry.id, controller);
  };

  return new TransformStream({
    transform(part, controller) {
      switch (part.type) {
        case "text-delta":
        case "reasoning-delta":
        case "tool-input-delta": {
          const kind = part.type.slice(0, -"-delta".length) as DeltaKind;
          const delta = restorer(kind, part.id, kind === "tool-input" ? tool : text).push(
            part.delta,
          );
          if (delta !== "" || part.providerMetadata !== undefined) {
            controller.enqueue({ ...part, delta });
          }
          return;
        }
        case "tool-input-start":
          // Raw text deltas aren't JSON yet, so they don't get JSON escaping.
          restorer("tool-input", part.id, part.inputEncoding === "text" ? toolText : tool);
          controller.enqueue(part);
          return;
        case "text-end":
        case "reasoning-end":
        case "tool-input-end":
          close(part.type.slice(0, -"-end".length) as DeltaKind, part.id, controller);
          controller.enqueue(part);
          return;
        case "tool-call":
          controller.enqueue({ ...part, input: vault.restore(part.input, tool) });
          return;
        case "finish":
        case "error":
          closeAll(controller);
          controller.enqueue(part);
          return;
        default:
          controller.enqueue(part);
      }
    },
    flush(controller) {
      closeAll(controller);
    },
  });
}
