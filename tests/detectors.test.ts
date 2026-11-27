import { describe, expect, it } from "vitest";
import {
  cardDetector,
  defaultDetectors,
  detectAll,
  emailDetector,
  ipv4Detector,
  luhnValid,
  patternDetector,
  phoneDetector,
} from "../src/detectors.js";
import { cardNumber, openaiKey } from "./fakes.js";

const values = (detector: ReturnType<typeof emailDetector>, text: string) =>
  detector.detect(text).map((found) => found.value);

describe("detectors", () => {
  it("finds emails", () => {
    expect(values(emailDetector(), "write to jane.doe+news@example.co.uk today")).toEqual([
      "jane.doe+news@example.co.uk",
    ]);
    expect(values(emailDetector(), "no@email here")).toEqual([]);
    expect(values(emailDetector(), "(.jane@example.com)")).toEqual(["jane@example.com"]);
    expect(values(emailDetector(), "a@b.c and x@-.io")).toEqual(["x@-.io"]);
  });

  // The old email regex was quadratic: 100k characters of "a." took about 16 seconds.
  it.each([
    ["a.", "a.".repeat(100_000)],
    ["a@b.", `a@${"b.".repeat(100_000)}`],
    ["1-", "1-".repeat(100_000)],
    ["+1 ", `+${"1 ".repeat(100_000)}`],
    ["sk-", "sk-".repeat(70_000)],
  ])("stays fast on long runs of %s", (_label, text) => {
    const started = performance.now();
    detectAll(text, defaultDetectors());
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("finds card numbers that pass the Luhn check, grouped or not", () => {
    const card = cardNumber();
    const grouped = card.replace(/(\d{4})(?=\d)/g, "$1 ");
    expect(values(cardDetector(), `pay with ${card} now`)).toEqual([card]);
    expect(values(cardDetector(), `card: ${grouped}.`)).toEqual([grouped]);
    const wrong = `${card.slice(0, -1)}${(Number(card.at(-1)) + 1) % 10}`;
    expect(values(cardDetector(), wrong)).toEqual([]);
    expect(values(cardDetector(), `order ${card}9 is long`)).toEqual([]);
  });

  it("checks Luhn sums", () => {
    expect(luhnValid(cardNumber(13))).toBe(true);
    expect(luhnValid("123")).toBe(false);
  });

  it("finds IPv4 addresses but not version numbers", () => {
    expect(values(ipv4Detector(), "server at 10.0.12.254, gateway 192.168.0.1")).toEqual([
      "10.0.12.254",
      "192.168.0.1",
    ]);
    expect(values(ipv4Detector(), "version 1.2.3.4.5 and 300.1.1.1")).toEqual([]);
  });

  it("finds international phone numbers", () => {
    expect(values(phoneDetector(), "call +44 20 7946 0958 or +1 (415) 555-0132")).toEqual([
      "+44 20 7946 0958",
      "+1 (415) 555-0132",
    ]);
    expect(values(phoneDetector(), "score +12-3 and 555-0132")).toEqual([]);
  });

  it("rejects bad placeholder types", () => {
    expect(() => patternDetector("x", "lower", /x/)).toThrow("upper-case");
  });

  it("lets earlier detectors win where matches overlap", () => {
    const key = openaiKey();
    const text = `mail ops@example.com the key ${key} please`;
    const found = detectAll(text, defaultDetectors());
    expect(found.map((d) => [d.type, d.source])).toEqual([
      ["EMAIL", "email"],
      ["SECRET", "openai-key"],
    ]);
    const overlapping = patternDetector("word", "WORD", /key \S+/);
    expect(detectAll(text, [...defaultDetectors(), overlapping]).map((d) => d.type)).toEqual([
      "EMAIL",
      "SECRET",
    ]);
  });
});
