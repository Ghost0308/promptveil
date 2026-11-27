# Security policy

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through GitHub instead:

https://github.com/Ghost0308/promptveil/security/advisories/new

That's the same as opening the **Security** tab of this repo and clicking **Report a vulnerability**. Only you and I can see the report.

I'll reply within 7 days. If the report checks out, I'll work on a fix and aim to release it within 90 days, usually much sooner. We'll agree on a disclosure date together. Once a fixed version is out I'll publish a security advisory, and I'll credit you in it and in the release notes if you'd like that.

## Supported versions

promptveil is still pre 1.0, so only the latest release gets security fixes.

## What I treat as a vulnerability

- A value reaches the model in a case the docs say is covered
- `restore` puts back a value of a type the caller left out of `types`
- A sealed vault can be read or changed without the key
- Input that makes a detector or rule take far longer than its length should allow
- Something in the build or release process that could let someone ship a tampered package

A secret format or kind of personal data that promptveil doesn't recognise yet is useful to know about too, but that can go in a normal issue. Please don't paste a real key or someone's real details, a made-up example in the same format is enough.
