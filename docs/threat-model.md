# Threat model

This is what promptveil tries to protect, what it trusts, and where it stops. If you find a gap that isn't written down here, please report it as described in [SECURITY.md](../SECURITY.md).

## What it protects

The values it finds in a prompt: API keys and tokens, email addresses, card numbers, IP addresses and phone numbers, plus anything your own detectors pick up. The goal is that these never leave your process in the prompt, and that they only come back in the places you choose.

## Who it's up against

The main one is the LLM provider, or anything between you and it that logs or stores prompts. promptveil assumes they can read everything you send.

The second is whoever controls content that ends up in the prompt or the reply. That includes the user, web pages and documents you paste in, tool results, and the model itself once a prompt injection has steered it. All model output is treated as untrusted.

Your own process is trusted. promptveil can't help if an attacker can already read your memory, your environment or your secret store.

## How each risk is handled

### A value slips past the detectors

Detection is pattern based. It finds things with a known shape and misses the rest: names, street addresses, free text that mentions something private, and secrets in formats it doesn't have a rule for. This is the biggest limit and there's no way around it with patterns alone. The `replacements` list from `redact` shows what was caught, so you can log and review it. New formats are added to the shared rules file, which safetape also uses, so both projects get them.

### The model writes a placeholder somewhere it shouldn't

Placeholders follow a public format, so anyone can guess `[[SECRET_1]]`. A prompt injection can ask the model to put it in a tool call, like a URL to fetch or an email to send. If you restore the tool arguments, the real value goes to whoever the injection picked.

`restore` and the streaming helpers take a `types` option for this. The AI SDK middleware uses it by default: tool call arguments get nothing back unless `toolCallTypes` lists a type.

Thinking blocks from the Anthropic API are signed, so the Anthropic helper passes them through untouched in both directions. That's safe because the model only ever saw placeholders, so its thinking can't contain the real values.

A restored value can also contain characters that mean something where it lands. A quote inside a value put back into JSON would end the string early and could add keys of the attacker's choosing. The middleware escapes values going into tool arguments and JSON output, and `RestoreOptions.encode` with `escapeJsonString` does the same for your own code. The rule I follow is to restore everything in text a person reads, and only the types a tool really needs in its arguments. Restoring never happens on its own, only where your code calls it.

A related case is text that already contains a placeholder before redaction, like a user typing `[[EMAIL_1]]`. A new placeholder never matches text that was already in the message being redacted, so restoring can't change what was there. With a vault reused across messages, an earlier placeholder can show up in a later message, and restoring will fill it in. That falls under the same rule: only restore what you mean to show.

### Someone reads a stored vault

A vault holds the real values, so it's as sensitive as they are. `seal` encrypts it with AES-256-GCM through WebCrypto, under a 32-byte key and a fresh random 12-byte IV for every seal. A fixed context string is bound in as additional data. Changing any part of the sealed JSON makes `unseal` fail, and so does the wrong key.

The key is yours to manage. Keep it in a secret store, apart from where sealed vaults are kept. With random IVs, a single key shouldn't seal more than about 2^32 vaults, so rotate it long before that.

### A value leaks through logs or errors

`Replacement` objects and errors never include the matched values. The vault keeps its maps in private class fields, so `JSON.stringify` and `console.log` on a vault don't print them. The `Detection` objects from detectors do include the value, since that's their job, so don't log those.

### Slow regexes

Every detector runs on whatever text the user sends, so a badly written regex is a denial of service. The built-in detectors keep their repeated parts bounded, and the tests time the default set on long adversarial runs. An earlier version of the email regex took about 16 seconds on 100k characters of `a.a.a.`, which is how I know the check matters. Custom rules and detectors you add are your responsibility. It's also sensible to cap prompt length before redacting.

### Supply chain

promptveil has no runtime dependencies. Dev dependencies are pinned to exact versions in package-lock.json, CI installs with `npm ci --ignore-scripts`, and `npm audit` plus `npm audit signatures` run on every push. All GitHub Actions are pinned to commit SHAs, workflows default to read-only permissions, and zizmor checks the workflow files themselves. Releases will go out through npm trusted publishing with provenance, so no long-lived token exists to steal.

## Out of scope

Anything the model can work out from the redacted text itself, like guessing who someone is from the context around a placeholder. Side channels such as prompt length or timing. Attackers who already run code inside your process.
