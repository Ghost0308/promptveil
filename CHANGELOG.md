# Changelog

## Unreleased

- `promptveil/anthropic` with `veilMessages`, for the Anthropic TypeScript SDK 1.x. It redacts a request and restores the reply or its stream events, and passes signed thinking blocks through untouched
- `placeholderNote()`, a short system note that tells the model what the placeholders are. Both adapters now add it by default on calls where something was redacted, since without it models often remark on the placeholders or drop them. Turn it off with `note: false`

## 0.1.0

First version.

- `redact` swaps secrets, emails, card numbers, IPv4 addresses and phone numbers for placeholders, and the same value always gets the same placeholder
- `Vault.restore` puts the values back, with a `types` option for places like tool arguments where only some should come back
- Streaming restore through `restorer`, `restoreStream` and `restoreIterable`, which holds back only a partial placeholder at the end of a chunk
- `seal` and `Vault.unseal` encrypt a vault with AES-256-GCM for keeping it between requests
- Custom detectors through `patternDetector`, and custom secret rules in the same JSON format safetape uses
- `promptveil/ai-sdk`, a middleware for the Vercel AI SDK 7 that redacts every call and restores replies and streams, with a separate rule for tool call arguments
- `RestoreOptions.encode` and `escapeJsonString`, for putting values back into JSON safely
- `RedactOptions.context`, so new placeholders also avoid text elsewhere in a conversation
