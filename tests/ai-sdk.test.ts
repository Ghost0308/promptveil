import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateText, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { promptveilMiddleware } from "../src/ai-sdk.js";
import { patternDetector } from "../src/detectors.js";
import { openaiKey } from "./fakes.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finishReason = { unified: "stop" as const, raw: undefined };

function generated(
  content: LanguageModelV4GenerateResult["content"],
): LanguageModelV4GenerateResult {
  return { content, finishReason, usage, warnings: [] };
}

function streamed(parts: LanguageModelV4StreamPart[]) {
  return { stream: convertArrayToReadableStream(parts) };
}

const finish: LanguageModelV4StreamPart = { type: "finish", usage, finishReason };

/** Every string in a prompt, so tests can check nothing sensitive got through. */
const promptText = (prompt: LanguageModelV4Prompt) => JSON.stringify(prompt);

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("generateText", () => {
  it("sends placeholders and gets real values back", async () => {
    const key = openaiKey();
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: "text", text: "Done, I emailed [[EMAIL_1]]." }]),
    });
    const result = await generateText({
      model: wrapLanguageModel({ model, middleware: promptveilMiddleware() }),
      instructions: "You help jane@example.com with ops.",
      prompt: `Rotate ${key} and tell jane@example.com.`,
    });

    const sent = promptText(model.doGenerateCalls[0]?.prompt ?? []);
    expect(sent).not.toContain("jane@example.com");
    expect(sent).not.toContain(key);
    expect(sent).toContain("[[EMAIL_1]]");
    expect(sent).toContain("[[SECRET_1]]");
    expect(result.text).toBe("Done, I emailed jane@example.com.");
  });

  it("restores tool arguments only for allowed types, and redacts the next step", async () => {
    const key = openaiKey();
    const calls: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [
        generated([
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "sendEmail",
            input: JSON.stringify({ to: "[[EMAIL_1]]", body: "key is [[SECRET_1]]" }),
          },
        ]),
        generated([{ type: "text", text: "Sent to [[EMAIL_1]]." }]),
      ],
    });
    const result = await generateText({
      model: wrapLanguageModel({
        model,
        middleware: promptveilMiddleware({ toolCallTypes: ["EMAIL"] }),
      }),
      prompt: `Email jane@example.com that the key is ${key}.`,
      tools: {
        sendEmail: tool({
          inputSchema: z.object({ to: z.string(), body: z.string() }),
          execute: async (input) => {
            calls.push(input);
            return { delivered: true, to: input.to };
          },
        }),
      },
      stopWhen: stepCountIs(2),
    });

    expect(calls).toEqual([{ to: "jane@example.com", body: "key is [[SECRET_1]]" }]);
    // The second call carries the tool call and its result, both redacted again.
    const second = promptText(model.doGenerateCalls[1]?.prompt ?? []);
    expect(second).not.toContain("jane@example.com");
    expect(second).not.toContain(key);
    expect(result.text).toBe("Sent to jane@example.com.");
  });

  it("gives each call its own vault", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: "text", text: "Hi [[EMAIL_1]]" }]),
    });
    const wrapped = wrapLanguageModel({ model, middleware: promptveilMiddleware() });
    const first = await generateText({ model: wrapped, prompt: "I'm a@example.com" });
    const second = await generateText({ model: wrapped, prompt: "I'm b@example.com" });
    expect(first.text).toBe("Hi a@example.com");
    expect(second.text).toBe("Hi b@example.com");
  });
});

describe("streamText", () => {
  it("restores placeholders split across deltas", async () => {
    const model = new MockLanguageModelV4({
      doStream: streamed([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "The user is [[EMA" },
        { type: "reasoning-delta", id: "r", delta: "IL_1]]." },
        { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Writing to [[" },
        { type: "text-delta", id: "t", delta: "EMAIL_1" },
        { type: "text-delta", id: "t", delta: "]] now" },
        { type: "text-end", id: "t" },
        finish,
      ]),
    });
    const result = streamText({
      model: wrapLanguageModel({ model, middleware: promptveilMiddleware() }),
      prompt: "Mail jane@example.com",
    });
    let text = "";
    for await (const chunk of result.textStream) text += chunk;
    expect(text).toBe("Writing to jane@example.com now");
    expect(await result.reasoningText).toBe("The user is jane@example.com.");
    expect(promptText(model.doStreamCalls[0]?.prompt ?? [])).not.toContain("jane@example.com");
  });
});

describe("the middleware on its own", () => {
  const call = (
    prompt: LanguageModelV4Prompt,
    extra: Partial<LanguageModelV4CallOptions> = {},
  ) => ({
    prompt,
    ...extra,
  });

  it("redacts every kind of prompt part", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generated([]) });
    const wrapped = wrapLanguageModel({ model, middleware: promptveilMiddleware() });
    const email = "jane@example.com";
    await wrapped.doGenerate(
      call([
        { role: "system", content: `Contact ${email}` },
        {
          role: "user",
          content: [
            { type: "text", text: `I'm ${email}` },
            {
              type: "file",
              mediaType: "text/plain",
              data: { type: "text", text: `notes: ${email}` },
            },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "url", url: new URL("https://example.com/a.png") },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: `thinking about ${email}` },
            { type: "text", text: `ok ${email}` },
            { type: "file", mediaType: "text/plain", data: { type: "text", text: email } },
            {
              type: "tool-call",
              toolCallId: "1",
              toolName: "lookup",
              input: { who: [email, 3, null] },
            },
            {
              type: "tool-result",
              toolCallId: "0",
              toolName: "x",
              output: { type: "text", value: email },
            },
            { type: "custom", kind: "test.part" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "1",
              toolName: "lookup",
              output: { type: "json", value: { email } },
            },
            {
              type: "tool-result",
              toolCallId: "2",
              toolName: "a",
              output: { type: "error-text", value: email },
            },
            {
              type: "tool-result",
              toolCallId: "3",
              toolName: "b",
              output: { type: "error-json", value: [email] },
            },
            {
              type: "tool-result",
              toolCallId: "4",
              toolName: "c",
              output: { type: "execution-denied", reason: email },
            },
            {
              type: "tool-result",
              toolCallId: "5",
              toolName: "d",
              output: { type: "execution-denied" },
            },
            {
              type: "tool-result",
              toolCallId: "6",
              toolName: "e",
              output: {
                type: "content",
                value: [
                  { type: "text", text: email },
                  { type: "file", mediaType: "text/plain", data: { type: "text", text: email } },
                  { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
                ],
              },
            },
            {
              type: "tool-approval-response",
              approvalId: "a1",
              approved: false,
              reason: `not for ${email}`,
            },
            { type: "tool-approval-response", approvalId: "a2", approved: true },
          ],
        },
      ]),
    );
    const sent = model.doGenerateCalls[0]?.prompt ?? [];
    expect(promptText(sent)).not.toContain(email);
    // 15 places hold the email: 1 system, 2 user, 4 assistant (plus 1 tool result there), 7 in the tool message.
    expect(promptText(sent).match(/\[\[EMAIL_1\]\]/g)).toHaveLength(15);
    // Non-text data passes through untouched.
    expect(promptText(sent)).toContain("https://example.com/a.png");
  });

  it("never reuses a placeholder that appears anywhere in the conversation", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generated([{ type: "text", text: "[[EMAIL_1]] [[EMAIL_2]]" }]),
    });
    const wrapped = wrapLanguageModel({ model, middleware: promptveilMiddleware() });
    const result = await wrapped.doGenerate(
      call([
        { role: "user", content: [{ type: "text", text: "my email is x@example.com" }] },
        { role: "assistant", content: [{ type: "text", text: "noted, [[EMAIL_1]] is a literal" }] },
      ]),
    );
    expect(promptText(model.doGenerateCalls[0]?.prompt ?? [])).toContain("my email is [[EMAIL_2]]");
    expect(result.content).toEqual([{ type: "text", text: "[[EMAIL_1]] x@example.com" }]);
  });

  it("escapes values going into JSON output", async () => {
    const quoted = patternDetector("nickname", "NICK", /Jane "JJ" Doe/);
    const model = new MockLanguageModelV4({
      doGenerate: {
        ...generated([{ type: "text", text: '{"name":"[[NICK_1]]"}' }]),
        structuredOutputText: '{"name":"[[NICK_1]]"}',
      },
    });
    const wrapped = wrapLanguageModel({
      model,
      middleware: promptveilMiddleware({ detectors: [quoted] }),
    });
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: 'Call me Jane "JJ" Doe' }] },
    ];

    const json = await wrapped.doGenerate(call(prompt, { responseFormat: { type: "json" } }));
    expect(json.content).toEqual([{ type: "text", text: '{"name":"Jane \\"JJ\\" Doe"}' }]);
    expect(JSON.parse(json.structuredOutputText ?? "")).toEqual({ name: 'Jane "JJ" Doe' });

    const plain = await wrapped.doGenerate(call(prompt));
    expect(plain.content).toEqual([{ type: "text", text: '{"name":"Jane "JJ" Doe"}' }]);
  });

  it("restores only the chosen text types", async () => {
    const key = openaiKey();
    const model = new MockLanguageModelV4({
      doGenerate: generated([
        { type: "text", text: "[[EMAIL_1]] [[SECRET_1]]" },
        { type: "reasoning", text: "[[SECRET_1]]" },
        { type: "source", sourceType: "url", id: "s", url: "https://example.com" },
      ]),
    });
    const wrapped = wrapLanguageModel({
      model,
      middleware: promptveilMiddleware({ textTypes: ["EMAIL"] }),
    });
    const result = await wrapped.doGenerate(
      call([{ role: "user", content: [{ type: "text", text: `a@example.com ${key}` }] }]),
    );
    expect(result.content).toEqual([
      { type: "text", text: "a@example.com [[SECRET_1]]" },
      { type: "reasoning", text: "[[SECRET_1]]" },
      { type: "source", sourceType: "url", id: "s", url: "https://example.com" },
    ]);
  });

  it("leaves results alone when nothing was redacted", async () => {
    const content = [{ type: "text" as const, text: "[[EMAIL_1]]" }];
    const model = new MockLanguageModelV4({
      doGenerate: generated(content),
      doStream: streamed([finish]),
    });
    const wrapped = wrapLanguageModel({ model, middleware: promptveilMiddleware() });
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "nothing here" }] },
    ];
    expect((await wrapped.doGenerate(call(prompt))).content).toEqual(content);
    expect(await collect((await wrapped.doStream(call(prompt))).stream)).toEqual([finish]);
  });

  it("streams tool input and tool calls with the tool rules", async () => {
    const model = new MockLanguageModelV4({
      doStream: streamed([
        { type: "tool-input-start", id: "j", toolName: "send" },
        { type: "tool-input-delta", id: "j", delta: '{"to":"[[EMA' },
        { type: "tool-input-delta", id: "j", delta: 'IL_1]]","note":"[[NICK_1]]"}' },
        { type: "tool-input-end", id: "j" },
        { type: "tool-input-start", id: "t", toolName: "raw", inputEncoding: "text" },
        { type: "tool-input-delta", id: "t", delta: "[[NICK_1]]" },
        { type: "tool-input-end", id: "t" },
        {
          type: "tool-call",
          toolCallId: "j",
          toolName: "send",
          input: '{"to":"[[EMAIL_1]]","note":"[[NICK_1]]"}',
        },
        finish,
      ]),
    });
    const quoted = patternDetector("nickname", "NICK", /Jane "JJ" Doe/);
    const wrapped = wrapLanguageModel({
      model,
      middleware: promptveilMiddleware({
        detectors: [quoted, ...defaultLike()],
        toolCallTypes: ["NICK"],
      }),
    });
    const parts = await collect(
      (
        await wrapped.doStream(
          call([
            { role: "user", content: [{ type: "text", text: 'a@example.com is Jane "JJ" Doe' }] },
          ]),
        )
      ).stream,
    );
    const deltas = (id: string) =>
      parts
        .filter((p) => p.type === "tool-input-delta" && p.id === id)
        .map((p) => (p.type === "tool-input-delta" ? p.delta : ""))
        .join("");
    expect(deltas("j")).toBe('{"to":"[[EMAIL_1]]","note":"Jane \\"JJ\\" Doe"}');
    expect(deltas("t")).toBe('Jane "JJ" Doe');
    expect(parts.find((p) => p.type === "tool-call")).toMatchObject({
      input: '{"to":"[[EMAIL_1]]","note":"Jane \\"JJ\\" Doe"}',
    });
  });

  it("flushes held-back text when a stream ends early", async () => {
    const model = new MockLanguageModelV4({
      doStream: streamed([
        { type: "text-delta", id: "t", delta: "bye [[EMA" },
        { type: "error", error: "connection dropped" },
        { type: "text-delta", id: "u", delta: "and [[EMAIL" },
      ]),
    });
    const wrapped = wrapLanguageModel({ model, middleware: promptveilMiddleware() });
    const parts = await collect(
      (
        await wrapped.doStream(
          call([{ role: "user", content: [{ type: "text", text: "a@example.com" }] }]),
        )
      ).stream,
    );
    expect(parts).toEqual([
      { type: "text-delta", id: "t", delta: "bye " },
      { type: "text-delta", id: "t", delta: "[[EMA" },
      { type: "error", error: "connection dropped" },
      { type: "text-delta", id: "u", delta: "and " },
      { type: "text-delta", id: "u", delta: "[[EMAIL" },
    ]);
  });
});

function defaultLike() {
  return [patternDetector("email", "EMAIL", /[a-z]+@example\.com/)];
}
