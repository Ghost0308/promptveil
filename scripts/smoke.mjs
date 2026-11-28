// Runs against the packed tarball in CI, the way someone who installed promptveil would use it.
import assert from "node:assert/strict";
import { generateKey, redact, Vault } from "promptveil";
import { promptveilMiddleware } from "promptveil/ai-sdk";
import { veilMessages } from "promptveil/anthropic";

const original = "Mail jane@example.com from 10.1.2.3";
const { text, vault } = redact(original);
assert.equal(text, "Mail [[EMAIL_1]] from [[IP_1]]");

const restorer = vault.restorer();
const streamed = restorer.push("Sure, [[EMA") + restorer.push("IL_1]] it is.") + restorer.end();
assert.equal(streamed, "Sure, jane@example.com it is.");

const key = generateKey();
const reopened = await Vault.unseal(await vault.seal(key), key);
assert.equal(reopened.restore(text), original);

// The AI SDK entry point loads without the AI SDK installed, since it only uses its types.
const middleware = promptveilMiddleware();
assert.equal(middleware.specificationVersion, "v4");
const params = await middleware.transformParams({
  type: "generate",
  params: { prompt: [{ role: "user", content: [{ type: "text", text: original }] }] },
});
// The placeholder note goes first, then the redacted message.
assert.equal(params.prompt[0].role, "system");
assert.equal(params.prompt[1].content[0].text, text);

// Same for the Anthropic SDK entry point.
const veiled = veilMessages({
  model: "claude-opus-5-5",
  max_tokens: 10,
  messages: [{ role: "user", content: original }],
});
assert.equal(veiled.params.messages[0].content, text);
assert.ok(veiled.params.system.includes("[[EMAIL_1]]"));

console.log("smoke test passed");
