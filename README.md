# promptveil

promptveil swaps secrets and personal data in a prompt for placeholders before it goes to an LLM, then puts the real values back in the reply. It works on streamed replies too, so a placeholder that gets split across two chunks still comes back in one piece.

It has no runtime dependencies. It's a sister project of [safetape](https://github.com/Ghost0308/safetape), which keeps secrets out of recorded test cassettes, and the two share the same secret rules file.

## Install

It's not on npm yet. Once the first release is out:

```sh
npm install promptveil
```

It needs Node 22.12 or newer. It only uses web standard APIs (WebCrypto and web streams), so other runtimes should work as well, but Node is the only one I test on.

## Quick start

```ts
import { redact } from "promptveil";

const { text, vault } = redact(
  "I'm jane@example.com and my card is 4111 1111 1111 1111. Can you draft a refund email?",
);
// "I'm [[EMAIL_1]] and my card is [[CARD_1]]. Can you draft a refund email?"

const reply = await askTheModel(text); // whatever client you use
console.log(vault.restore(reply));
```

The model only ever sees the placeholders. When it writes `[[EMAIL_1]]` in its reply, `restore` turns it back into the address.

## Streaming

```ts
for await (const chunk of vault.restoreIterable(textChunks)) {
  process.stdout.write(chunk);
}
```

`textChunks` is any async iterable of strings, like the text stream most SDKs give you. If a chunk ends partway through something that could still turn into a placeholder, like `[[EMA`, that bit is held back until the next chunk shows what it is. Everything else goes straight through.

For web streams there's `vault.restoreStream()`, which is a `TransformStream<string, string>`. If you'd rather drive it yourself, `vault.restorer()` gives you an object with `push(chunk)` and `end()`.

## Conversations

Pass the same vault in for each message, so a value keeps its placeholder for the whole conversation:

```ts
const first = redact(message1);
const second = redact(message2, { vault: first.vault });
```

To keep a vault between requests, seal it. That encrypts it with AES-256-GCM under a 32-byte key:

```ts
import { generateKey, Vault } from "promptveil";

const key = generateKey(); // keep this in your secret store, away from the sealed vault
const sealed = await vault.seal(key); // plain JSON, fine to put in a session or a database
const reopened = await Vault.unseal(sealed, key); // throws if the key is wrong or the data was changed
```

## Tool calls

Be careful where you restore. Model output is untrusted, and a prompt injection can get the model to write `[[SECRET_1]]` into a tool call, say a URL it wants fetched. If your code restores tool arguments, the real value goes out with the request.

So restore freely in text a person reads. In tool arguments, restore only the types that tool really needs, or none at all:

```ts
const args = vault.restore(toolCall.arguments, { types: ["EMAIL"] });
```

`restorer`, `restoreStream` and `restoreIterable` take the same `types` option.

## With the Vercel AI SDK

If you use the AI SDK (version 7), one middleware does all of this for every provider it supports:

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, wrapLanguageModel } from "ai";
import { promptveilMiddleware } from "promptveil/ai-sdk";

const model = wrapLanguageModel({
  model: anthropic("claude-opus-5-5"),
  middleware: promptveilMiddleware(),
});

const { text } = await generateText({ model, prompt: "Draft a reply to jane@example.com" });
```

On every call it redacts everything the model would see, including tool calls and tool results from earlier steps, and puts the values back in the reply, streamed or not. Each call gets a fresh vault, so nothing carries over between users or requests.

Tool call arguments get no values back unless you list the types they may have with `toolCallTypes`, for example `promptveilMiddleware({ toolCallTypes: ["EMAIL"] })`. Values that go back into JSON, like tool arguments or JSON output, are escaped first, so a value with a quote in it can't break the JSON.

It adds no dependencies. `@ai-sdk/provider` is an optional peer dependency, and only its types are used.

## What it looks for

By default it finds:

- API keys and tokens, using the same rules as safetape (OpenAI, Anthropic, AWS, GitHub, Stripe, Slack, JWTs, private keys, passwords in URLs and more)
- email addresses
- card numbers that pass the Luhn check
- IPv4 addresses
- phone numbers in international format, starting with +

These become `SECRET`, `EMAIL`, `CARD`, `IP` and `PHONE` placeholders.

You can pick your own set of detectors, or add one:

```ts
import { emailDetector, patternDetector, redact, secretsDetector } from "promptveil";

const customerId = patternDetector("customer-id", "CUSTOMER", /\bCUS-\d{6}\b/);
redact(text, { detectors: [secretsDetector(), emailDetector(), customerId] });
```

When two detectors match overlapping text, the one earlier in the list wins.

For your own secret formats, write a rules file in the JSON format safetape uses, load it with `parseRules`, and pass the result to `secretsDetector`.

If `[[...]]` clashes with something in your prompts, pick another format with `new Vault({ prefix: "<", suffix: ">" })` and pass that vault to `redact`.

## What it won't catch

It works on patterns, so it finds things with a recognisable shape. It won't find names, street addresses, or anything else where you'd need to understand the text. A secret in a format it doesn't know will also get through. I think of it as one layer of protection, and it's worth checking what it caught. `redact` returns a `replacements` list with the type, position and placeholder of each match (never the value), so it's safe to log.

The [threat model](https://github.com/Ghost0308/promptveil/blob/main/docs/threat-model.md) goes into more detail.

## License

MIT
