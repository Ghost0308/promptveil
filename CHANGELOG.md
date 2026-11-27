# Changelog

## Unreleased

First version.

- `redact` swaps secrets, emails, card numbers, IPv4 addresses and phone numbers for placeholders, and the same value always gets the same placeholder
- `Vault.restore` puts the values back, with a `types` option for places like tool arguments where only some should come back
- Streaming restore through `restorer`, `restoreStream` and `restoreIterable`, which holds back only a partial placeholder at the end of a chunk
- `seal` and `Vault.unseal` encrypt a vault with AES-256-GCM for keeping it between requests
- Custom detectors through `patternDetector`, and custom secret rules in the same JSON format safetape uses
