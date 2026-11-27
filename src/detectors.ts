import { defaultRules, type Ruleset } from "./rules.js";

/** A piece of text that should not reach the model. `value` is the sensitive text itself. */
export interface Detection {
  /** Placeholder type, like EMAIL or SECRET. Upper-case letters and digits only. */
  readonly type: string;
  /** Which rule or detector found it, for logs. */
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export interface Detector {
  readonly name: string;
  detect(text: string): Detection[];
}

/** API keys, tokens and private keys, using the shared secret rules. */
export function secretsDetector(ruleset: Ruleset = defaultRules()): Detector {
  return {
    name: "secrets",
    detect: (text) =>
      ruleset.find(text).map((hit) => ({
        type: "SECRET",
        source: hit.rule.id,
        start: hit.start,
        end: hit.end,
        value: hit.value,
      })),
  };
}

/** A detector built from a regex. `accept` can reject a match, for checksums and the like. */
export function patternDetector(
  name: string,
  type: string,
  pattern: RegExp,
  accept: (value: string) => boolean = () => true,
): Detector {
  if (!/^[A-Z][A-Z0-9]*$/.test(type)) {
    throw new Error(`placeholder type '${type}' must be upper-case letters and digits`);
  }
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  return {
    name,
    detect(text) {
      const found: Detection[] = [];
      for (const match of text.matchAll(global)) {
        const value = match[0];
        if (value.length === 0 || !accept(value)) continue;
        found.push({
          type,
          source: name,
          start: match.index,
          end: match.index + value.length,
          value,
        });
      }
      return found;
    },
  };
}

/**
 * Email addresses. Every part has an upper bound (64 for the local part and 63 per
 * domain label, as in the RFCs) so a long run like "a.a.a.a..." can't make the
 * regex scan to the end of the text from every position.
 */
export const emailDetector = (): Detector =>
  patternDetector(
    "email",
    "EMAIL",
    /(?<![A-Za-z0-9])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9-]{1,63}\.){1,10}[A-Za-z]{2,63}(?![A-Za-z0-9-])/,
  );

/** Payment card numbers: 13 to 19 digits, optionally grouped, that pass the Luhn check. */
export const cardDetector = (): Detector =>
  patternDetector("card", "CARD", /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/, (value) =>
    luhnValid(value.replace(/[ -]/g, "")),
  );

export const ipv4Detector = (): Detector =>
  patternDetector(
    "ipv4",
    "IP",
    /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/,
  );

/** International phone numbers written with a leading +, 8 to 15 digits in all. */
export const phoneDetector = (): Detector =>
  patternDetector("phone", "PHONE", /(?<![\w+])\+\d[\d ().-]{6,20}\d(?!\d)/, (value) => {
    const digits = value.replace(/\D/g, "").length;
    return digits >= 8 && digits <= 15;
  });

/** Secrets first, so a key that also looks like something else is treated as a secret. */
export function defaultDetectors(): Detector[] {
  return [secretsDetector(), emailDetector(), cardDetector(), ipv4Detector(), phoneDetector()];
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * All detections from all detectors, in text order. Where two overlap, the one
 * from the earlier detector wins, then the one that starts first.
 */
export function detectAll(text: string, detectors: readonly Detector[]): Detection[] {
  const kept: Detection[] = [];
  for (const detector of detectors) {
    for (const found of detector.detect(text)) {
      if (!kept.some((k) => found.start < k.end && k.start < found.end)) kept.push(found);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}
