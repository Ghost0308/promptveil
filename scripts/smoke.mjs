// Runs against the packed tarball in CI, the way someone who installed promptveil would use it.
import assert from "node:assert/strict";
import { generateKey, redact, Vault } from "promptveil";

const original = "Mail jane@example.com from 10.1.2.3";
const { text, vault } = redact(original);
assert.equal(text, "Mail [[EMAIL_1]] from [[IP_1]]");

const restorer = vault.restorer();
const streamed = restorer.push("Sure, [[EMA") + restorer.push("IL_1]] it is.") + restorer.end();
assert.equal(streamed, "Sure, jane@example.com it is.");

const key = generateKey();
const reopened = await Vault.unseal(await vault.seal(key), key);
assert.equal(reopened.restore(text), original);

console.log("smoke test passed");
