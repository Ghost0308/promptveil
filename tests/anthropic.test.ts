import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { veilMessages } from "../src/anthropic.js";
import { patternDetector } from "../src/detectors.js";
import { placeholderNote } from "../src/note.js";
import { openaiKey } from "./fakes.js";

type Event = Anthropic.RawMessageStreamEvent;

/** A real SDK client whose requests never leave the process. */
function fakeClient(respond: (body: Record<string, unknown>) => Response) {
  const requests: Record<string, unknown>[] = [];
  const client = new Anthropic({
    apiKey: "not-a-real-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return respond(body);
    },
  });
  return { client, requests };
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

const sse = (events: unknown[]) =>
  new Response(
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const message = (content: unknown[]) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const streamOf = (content: Event[]): unknown[] => [
  { type: "message_start", message: message([]) },
  ...content,
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];

async function collect(events: AsyncIterable<Event>) {
  const out: Event[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const textOf = (events: Event[]) =>
  events
    .map((e) =>
      e.type === "content_block_delta" && e.delta.type === "text_delta" ? e.delta.text : "",
    )
    .join("");

const quoted = patternDetector("nickname", "NICK", /Jane "JJ" Doe/);
const email = "jane@example.com";

describe("with the real SDK client", () => {
  it("sends placeholders and restores the reply", async () => {
    const key = openaiKey();
    const { client, requests } = fakeClient(() =>
      json(message([{ type: "text", text: "Emailed [[EMAIL_1]].", citations: null }])),
    );
    const veiled = veilMessages({
      model: "claude-opus-5-5",
      max_tokens: 200,
      system: "Help the user.",
      messages: [{ role: "user", content: `Rotate ${key} and tell ${email}.` }],
    });
    const reply = veiled.restore(await client.messages.create(veiled.params));

    const sent = JSON.stringify(requests[0]);
    expect(sent).not.toContain(email);
    expect(sent).not.toContain(key);
    expect(requests[0]?.system).toBe(`${placeholderNote()}\n\nHelp the user.`);
    expect(reply.content).toEqual([{ type: "text", text: `Emailed ${email}.`, citations: null }]);
  });

  it("restores tool input only for allowed types", async () => {
    const key = openaiKey();
    const { client } = fakeClient(() =>
      json(
        message([
          {
            type: "tool_use",
            id: "toolu_1",
            name: "send_email",
            input: { to: "[[EMAIL_1]]", body: "key is [[SECRET_1]]", cc: ["[[EMAIL_1]]", 2] },
          },
        ]),
      ),
    );
    const veiled = veilMessages(
      {
        model: "claude-opus-5-5",
        max_tokens: 200,
        messages: [{ role: "user", content: `Email ${email} the key ${key}.` }],
      },
      { toolCallTypes: ["EMAIL"] },
    );
    const reply = veiled.restore(await client.messages.create(veiled.params));
    expect(reply.content[0]).toMatchObject({
      input: { to: email, body: "key is [[SECRET_1]]", cc: [email, 2] },
    });
  });

  it("restores streamed events from create({ stream: true })", async () => {
    const { client } = fakeClient(() =>
      sse(
        streamOf([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "user is [[EMAIL_1]]" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "", citations: null },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Writing to [[EMA" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "IL_1]] now" },
          },
          { type: "content_block_stop", index: 1 },
        ] as Event[]),
      ),
    );
    const veiled = veilMessages({
      model: "claude-opus-5-5",
      max_tokens: 200,
      messages: [{ role: "user", content: `Mail ${email}` }],
    });
    const events = await collect(
      veiled.restoreStream(await client.messages.create({ ...veiled.params, stream: true })),
    );
    expect(textOf(events)).toBe(`Writing to ${email} now`);
    // Thinking is signed, so it stays as the model wrote it.
    expect(JSON.stringify(events)).toContain("user is [[EMAIL_1]]");
  });

  it("works with client.messages.stream()", async () => {
    const { client } = fakeClient(() =>
      sse(
        streamOf([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hi [[EMAIL" },
          },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "_1]]" } },
          { type: "content_block_stop", index: 0 },
        ] as Event[]),
      ),
    );
    const veiled = veilMessages({
      model: "claude-opus-5-5",
      max_tokens: 200,
      messages: [{ role: "user", content: `I'm ${email}` }],
    });
    const stream = client.messages.stream(veiled.params);
    expect(textOf(await collect(veiled.restoreStream(stream)))).toBe(`Hi ${email}`);
    const final = veiled.restore(await stream.finalMessage());
    expect(final.content[0]).toMatchObject({ type: "text", text: `Hi ${email}` });
  });
});

describe("redacting requests", () => {
  it("covers every kind of block that carries user text", () => {
    const veiled = veilMessages(
      {
        model: "claude-opus-5-5",
        max_tokens: 100,
        system: [{ type: "text", text: `Contact ${email}` }],
        messages: [
          { role: "system", content: `Also ${email}` },
          { role: "system", content: [{ type: "text", text: email }] },
          {
            role: "user",
            content: [
              { type: "text", text: `I'm ${email}` },
              {
                type: "document",
                title: `Notes for ${email}`,
                context: `About ${email}`,
                source: { type: "text", media_type: "text/plain", data: `Owner ${email}` },
              },
              {
                type: "document",
                source: {
                  type: "content",
                  content: [
                    { type: "text", text: email },
                    { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
                  ],
                },
              },
              { type: "document", source: { type: "content", content: email } },
              { type: "document", source: { type: "url", url: "https://example.com/a.pdf" } },
              {
                type: "search_result",
                source: "https://example.com",
                title: email,
                content: [{ type: "text", text: email }],
              },
              { type: "image", source: { type: "url", url: "https://example.com/b.png" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "the user is [[EMAIL_1]]", signature: "sig" },
              {
                type: "text",
                text: `Noted, ${email}`,
                citations: [
                  {
                    type: "char_location",
                    cited_text: email,
                    document_index: 0,
                    document_title: null,
                    start_char_index: 0,
                    end_char_index: 16,
                  },
                ],
              },
              { type: "tool_use", id: "t1", name: "lookup", input: { who: [email, null, 1] } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: email },
              {
                type: "tool_result",
                tool_use_id: "t2",
                content: [
                  { type: "text", text: email },
                  {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: email },
                  },
                  {
                    type: "search_result",
                    source: "s",
                    title: "t",
                    content: [{ type: "text", text: email }],
                  },
                  { type: "image", source: { type: "url", url: "https://example.com/c.png" } },
                ],
              },
              { type: "tool_result", tool_use_id: "t3" },
            ],
          },
        ],
      },
      { note: false },
    );
    const sent = JSON.stringify(veiled.params);
    expect(sent).not.toContain(email);
    // 3 in system, 8 from the user, 4 from the assistant (one is the thinking block's
    // own text, passed through as is) and 4 in tool results.
    expect(sent.match(/\[\[EMAIL_1\]\]/g)).toHaveLength(19);
    expect(sent).toContain('"signature":"sig"');
    expect(sent).toContain("https://example.com/a.pdf");
  });

  it("adds the note in the right place, only when something was redacted", () => {
    const systemOf = (
      text: string,
      options: Parameters<typeof veilMessages>[1] = {},
      system?: Anthropic.MessageCreateParams["system"],
    ) => {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: "claude-opus-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: text }],
        ...(system === undefined ? {} : { system }),
      };
      return veilMessages(params, options).params.system;
    };
    expect(systemOf(email)).toBe(placeholderNote());
    expect(systemOf(email, {}, [{ type: "text", text: "Be brief." }])).toEqual([
      { type: "text", text: placeholderNote() },
      { type: "text", text: "Be brief." },
    ]);
    expect(systemOf(email, { note: "Custom." })).toBe("Custom.");
    expect(systemOf(email, { note: false })).toBeUndefined();
    expect(systemOf("nothing private")).toBeUndefined();
  });

  it("never reuses a placeholder that appears in the conversation", () => {
    const veiled = veilMessages(
      {
        model: "claude-opus-5-5",
        max_tokens: 10,
        messages: [
          { role: "user", content: "a literal [[EMAIL_1]]" },
          { role: "user", content: `real ${email}` },
        ],
      },
      { note: false },
    );
    expect(veiled.params.messages[1]?.content).toBe("real [[EMAIL_2]]");
  });
});

describe("restoring replies", () => {
  const veil = (text: string, extra = {}) =>
    veilMessages(
      {
        model: "claude-opus-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: text }],
        ...extra,
      },
      {
        detectors: [quoted, patternDetector("email", "EMAIL", /[a-z]+@example\.com/)],
        note: false,
      },
    );

  // Seen from Ollama's Anthropic-compatible API: text blocks with no citations field at all.
  it("copes with text blocks that leave out citations", () => {
    const veiled = veil(`I'm ${email}`);
    const reply = veiled.restore(
      message([{ type: "text", text: "Hi [[EMAIL_1]]" }]) as unknown as Anthropic.Message,
    );
    expect(reply.content).toEqual([{ type: "text", text: `Hi ${email}` }]);
  });

  it("restores text, citations and tool input, and leaves other blocks alone", () => {
    const veiled = veil(`${email} is Jane "JJ" Doe`);
    const reply = veiled.restore(
      message([
        {
          type: "text",
          text: "[[NICK_1]] at [[EMAIL_1]]",
          citations: [
            {
              type: "char_location",
              cited_text: "[[EMAIL_1]]",
              document_index: 0,
              document_title: null,
              file_id: null,
              start_char_index: 0,
              end_char_index: 1,
            },
          ],
        },
        { type: "thinking", thinking: "[[EMAIL_1]]", signature: "s" },
      ]) as unknown as Anthropic.Message,
    );
    expect(reply.content[0]).toMatchObject({
      text: `Jane "JJ" Doe at ${email}`,
      citations: [{ cited_text: email }],
    });
    expect(reply.content[1]).toEqual({ type: "thinking", thinking: "[[EMAIL_1]]", signature: "s" });
  });

  it("escapes values when the output is JSON", () => {
    const veiled = veil('Call me Jane "JJ" Doe', {
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    const reply = veiled.restore(
      message([
        { type: "text", text: '{"name":"[[NICK_1]]"}', citations: null },
      ]) as unknown as Anthropic.Message,
    );
    const block = reply.content[0] as Anthropic.TextBlock;
    expect(JSON.parse(block.text)).toEqual({ name: 'Jane "JJ" Doe' });
  });

  it("can restore only some text types", () => {
    const veiled = veilMessages(
      {
        model: "claude-opus-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: `${email} ${openaiKey()}` }],
      },
      { textTypes: ["EMAIL"], note: false },
    );
    const reply = veiled.restore(
      message([
        { type: "text", text: "[[EMAIL_1]] [[SECRET_1]]", citations: null },
      ]) as unknown as Anthropic.Message,
    );
    expect(reply.content[0]).toMatchObject({ text: `${email} [[SECRET_1]]` });
  });

  it("leaves everything alone when nothing was redacted", async () => {
    const veiled = veil("nothing private");
    const reply = message([
      { type: "text", text: "[[EMAIL_1]]", citations: null },
    ]) as unknown as Anthropic.Message;
    expect(veiled.restore(reply)).toBe(reply);
    const events = [{ type: "message_stop" }] as Event[];
    expect(await collect(veiled.restoreStream(fromArray(events)))).toEqual(events);
  });
});

describe("restoring streams", () => {
  it("escapes streamed tool input and restores citations and start blocks", async () => {
    const veiled = veilMessages(
      {
        model: "claude-opus-5-5",
        max_tokens: 10,
        messages: [{ role: "user", content: `${email} is Jane "JJ" Doe` }],
      },
      {
        detectors: [quoted, patternDetector("email", "EMAIL", /[a-z]+@example\.com/)],
        toolCallTypes: ["NICK"],
        note: false,
      },
    );
    const events = await collect(
      veiled.restoreStream(
        fromArray([
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "t",
              name: "send",
              input: { note: "[[NICK_1]]" },
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"to":"[[EMA' },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: 'IL_1]]","note":"[[NICK_1]]"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "[[NICK_1]] ", citations: null },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "citations_delta",
              citation: {
                type: "char_location",
                cited_text: "[[EMAIL_1]]",
                document_index: 0,
                document_title: null,
                file_id: null,
                start_char_index: 0,
                end_char_index: 1,
              },
            },
          },
          {
            type: "content_block_start",
            index: 2,
            content_block: { type: "server_tool_use", id: "s", name: "web_search", input: {} },
          },
        ] as unknown as Event[]),
      ),
    );
    const partial = events
      .map((e) =>
        e.type === "content_block_delta" && e.delta.type === "input_json_delta"
          ? e.delta.partial_json
          : "",
      )
      .join("");
    expect(JSON.parse(partial)).toEqual({ to: "[[EMAIL_1]]", note: 'Jane "JJ" Doe' });
    expect(events[0]).toMatchObject({ content_block: { input: { note: 'Jane "JJ" Doe' } } });
    expect(JSON.stringify(events)).toContain(`"cited_text":"${email}"`);
    expect(events).toContainEqual({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: 'Jane "JJ" Doe ', citations: null },
    });
  });

  it("flushes held-back text at message_stop and at the end", async () => {
    const veiled = veilMessages(
      { model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: email }] },
      { note: false },
    );
    const run = async (tail: Event[]) =>
      collect(
        veiled.restoreStream(
          fromArray([
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "bye [[EMA" },
            },
            ...tail,
          ] as Event[]),
        ),
      );
    expect(await run([{ type: "message_stop" }] as Event[])).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bye " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[[EMA" } },
      { type: "message_stop" },
    ]);
    expect(await run([])).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bye " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[[EMA" } },
    ]);
  });
});

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}
