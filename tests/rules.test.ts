import { describe, expect, it } from "vitest";
import { defaultRules, parseRules, RulesError, shannonEntropy } from "../src/rules.js";
import bundled from "../src/rules.json" with { type: "json" };
import { chars, SAMPLES } from "./fakes.js";

const RULES = defaultRules();

describe("bundled rules", () => {
  it("has a fake sample for every rule", () => {
    expect(new Set(RULES.rules.map((rule) => rule.id))).toEqual(new Set(Object.keys(SAMPLES)));
  });

  // The same file runs in safetape under Python, so every regex has to work in JavaScript too.
  it.each(Object.keys(SAMPLES))("finds a %s sample with its own rule", (ruleId) => {
    const sample = (SAMPLES[ruleId] as () => { text: string; secret: string })();
    const hits = RULES.find(`some text before ${sample.text} and after`);
    expect(hits.map((hit) => hit.rule.id)).toEqual([ruleId]);
    expect(hits[0]?.value).toBe(sample.secret);
  });

  it.each([
    `sk-${"proj-"}${"x".repeat(40)}`,
    `AK${"IAIOSFODNN7"}EXAMPLE`,
    '"api_key": "your-api-key-goes-here"',
    "Authorization: Bearer YOUR_TOKEN",
    `Bearer fake${chars(30)}`,
  ])("treats %s as a placeholder", (text) => {
    expect(RULES.find(text)).toEqual([]);
  });

  it("counts overlapping matches once", () => {
    const key = (SAMPLES["openai-key"] as () => { secret: string })().secret;
    expect(RULES.find(`Authorization: Bearer ${key}`).map((hit) => hit.rule.id)).toEqual([
      "openai-key",
    ]);
  });

  it("parses the same file safetape ships", () => {
    expect(bundled.version).toBe(1);
    expect(RULES.rules).toHaveLength(bundled.rules.length);
  });
});

describe("entropy", () => {
  it("measures bits per character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBeCloseTo(2);
  });
});

describe("parseRules", () => {
  const rule = {
    id: "corp",
    description: "Corp token",
    regex: "corp_[0-9]{8}",
    keywords: ["corp_"],
  };
  const file = (
    overrides: Record<string, unknown> = {},
    ruleOverrides: Record<string, unknown> = {},
  ) => ({
    version: 1,
    rules: [{ ...rule, ...ruleOverrides }],
    ...overrides,
  });

  it("loads a custom rules file", () => {
    const ruleset = parseRules(file({ allow: ["corp_0000"] }));
    expect(ruleset.find("x corp_12345678 y").map((hit) => hit.value)).toEqual(["corp_12345678"]);
    expect(ruleset.find("corp_00001234")).toEqual([]);
  });

  it.each([
    [[], "expected a JSON object"],
    [file({ extra: 1 }), "unknown keys"],
    [file({ version: 2 }), "unsupported version"],
    [file({ allow: [""] }), "'allow' must be"],
    [file({ rules: {} }), "'rules' must be a list"],
    [file({ rules: ["x"] }), "expected an object"],
    [file({}, { colour: "red" }), "unknown keys"],
    [file({}, { id: "" }), "non-empty strings"],
    [file({}, { keywords: "corp_" }), "'keywords' must be"],
    [file({}, { flags: "g" }), "'flags' can only be"],
    [file({}, { regex: "(" }), "bad regex"],
    [file({}, { secret_group: 1 }), "'secret_group' must"],
    [file({}, { min_entropy: -1 }), "'min_entropy' must"],
  ])("rejects a bad file (%#)", (data, message) => {
    expect(() => parseRules(data)).toThrow(RulesError);
    expect(() => parseRules(data)).toThrow(message);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseRules({ version: 1, rules: [rule, rule] })).toThrow("used twice");
  });
});
