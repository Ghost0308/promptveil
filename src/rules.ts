// Secret rules shared with safetape (https://github.com/Ghost0308/safetape).
// rules.json is the same file in both projects; its regexes use syntax that
// Python and JavaScript read the same way.

import bundled from "./rules.json" with { type: "json" };

export interface Rule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly keywords: readonly string[];
  readonly secretGroup: number;
  readonly minEntropy: number;
}

export interface Hit {
  readonly rule: Rule;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export class RulesError extends Error {
  override name = "RulesError";
}

const RULE_KEYS = new Set([
  "id",
  "description",
  "regex",
  "keywords",
  "flags",
  "secret_group",
  "min_entropy",
]);
const TOP_KEYS = new Set(["version", "about", "allow", "suspicious_headers", "rules"]);

/** Bits of entropy per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export class Ruleset {
  readonly rules: readonly Rule[];
  readonly allowTerms: readonly string[];

  constructor(rules: readonly Rule[], allowTerms: readonly string[] = []) {
    this.rules = rules;
    this.allowTerms = allowTerms.map((term) => term.toLowerCase());
  }

  isAllowed(value: string): boolean {
    const lowered = value.toLowerCase();
    return this.allowTerms.some((term) => lowered.includes(term));
  }

  /** Every secret in `text`, in order. Overlapping matches count once; earlier rules win. */
  find(text: string): Hit[] {
    const lowered = text.toLowerCase();
    const kept: Hit[] = [];
    for (const rule of this.rules) {
      if (rule.keywords.length > 0 && !rule.keywords.some((k) => lowered.includes(k))) continue;
      for (const match of text.matchAll(rule.pattern)) {
        const span = match.indices?.[rule.secretGroup];
        if (span === undefined) continue;
        const [start, end] = span;
        const value = text.slice(start, end);
        if (rule.minEntropy > 0 && shannonEntropy(value) < rule.minEntropy) continue;
        if (this.isAllowed(value)) continue;
        if (kept.some((hit) => start < hit.end && hit.start < end)) continue;
        kept.push({ rule, start, end, value });
      }
    }
    return kept.sort((a, b) => a.start - b.start);
  }
}

/** Parse a rules file in safetape's JSON format. */
export function parseRules(data: unknown, origin = "rules"): Ruleset {
  if (!isRecord(data)) throw new RulesError(`${origin}: expected a JSON object at the top level`);
  const unknownTop = Object.keys(data).filter((key) => !TOP_KEYS.has(key));
  if (unknownTop.length > 0)
    throw new RulesError(`${origin}: unknown keys ${unknownTop.join(", ")}`);
  if (data.version !== 1)
    throw new RulesError(`${origin}: unsupported version ${String(data.version)}`);

  const allow = data.allow ?? [];
  if (!isStringList(allow)) throw new RulesError(`${origin}: 'allow' must be a list of strings`);
  if (!Array.isArray(data.rules)) throw new RulesError(`${origin}: 'rules' must be a list`);

  const seen = new Set<string>();
  const rules = data.rules.map((raw: unknown, index: number) => {
    const rule = parseRule(raw, `${origin} rule ${index}`);
    if (seen.has(rule.id)) throw new RulesError(`${origin}: rule id '${rule.id}' is used twice`);
    seen.add(rule.id);
    return rule;
  });
  return new Ruleset(rules, allow);
}

function parseRule(raw: unknown, where: string): Rule {
  if (!isRecord(raw)) throw new RulesError(`${where}: expected an object`);
  const unknown = Object.keys(raw).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length > 0) throw new RulesError(`${where}: unknown keys ${unknown.join(", ")}`);
  const { id, description, regex, keywords } = raw;
  if (!isNonEmptyString(id) || !isNonEmptyString(description) || !isNonEmptyString(regex)) {
    throw new RulesError(`${where}: 'id', 'description' and 'regex' must be non-empty strings`);
  }
  if (!isStringList(keywords))
    throw new RulesError(`${where}: 'keywords' must be a list of strings`);

  const flags = raw.flags ?? "";
  if (flags !== "" && flags !== "i")
    throw new RulesError(`${where}: 'flags' can only be "" or "i"`);
  let pattern: RegExp;
  try {
    // "d" gives match indices for the secret group, "g" lets matchAll walk the text.
    pattern = new RegExp(regex, `gd${flags}`);
  } catch (error) {
    throw new RulesError(`${where}: bad regex: ${(error as Error).message}`);
  }

  const secretGroup = raw.secret_group ?? 0;
  const groups = new RegExp(`${regex}|`).exec("")?.length ?? 1;
  if (
    typeof secretGroup !== "number" ||
    !Number.isInteger(secretGroup) ||
    secretGroup < 0 ||
    secretGroup >= groups
  ) {
    throw new RulesError(`${where}: 'secret_group' must name a group in the regex`);
  }
  const minEntropy = raw.min_entropy ?? 0;
  if (typeof minEntropy !== "number" || minEntropy < 0) {
    throw new RulesError(`${where}: 'min_entropy' must be a number of at least 0`);
  }
  return {
    id,
    description,
    pattern,
    keywords: keywords.map((k) => k.toLowerCase()),
    secretGroup,
    minEntropy,
  };
}

let defaultRuleset: Ruleset | undefined;

/** The rules that ship with promptveil (the same set safetape uses). */
export function defaultRules(): Ruleset {
  defaultRuleset ??= parseRules(bundled, "promptveil/rules.json");
  return defaultRuleset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}
