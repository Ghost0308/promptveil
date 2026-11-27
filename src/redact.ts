import { type Detector, defaultDetectors, detectAll } from "./detectors.js";
import { Vault } from "./vault.js";

export interface RedactOptions {
  /** Reuse a vault across messages so the same value keeps the same placeholder. */
  readonly vault?: Vault;
  /** What to look for. Defaults to secrets, emails, card numbers, IPv4 addresses and phone numbers. */
  readonly detectors?: readonly Detector[];
}

/** What was replaced, without the sensitive value itself, so it's safe to log. */
export interface Replacement {
  readonly type: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

export interface RedactResult {
  readonly text: string;
  readonly vault: Vault;
  readonly replacements: readonly Replacement[];
}

/** Replace sensitive values in `text` with placeholders the vault can turn back. */
export function redact(text: string, options: RedactOptions = {}): RedactResult {
  const vault = options.vault ?? new Vault();
  const detections = detectAll(text, options.detectors ?? defaultDetectors());
  const parts: string[] = [];
  const replacements: Replacement[] = [];
  let position = 0;
  for (const found of detections) {
    const placeholder = vault.placeholderFor(found.type, found.value, text);
    parts.push(text.slice(position, found.start), placeholder);
    replacements.push({
      type: found.type,
      source: found.source,
      start: found.start,
      end: found.end,
      placeholder,
    });
    position = found.end;
  }
  parts.push(text.slice(position));
  return { text: parts.join(""), vault, replacements };
}
