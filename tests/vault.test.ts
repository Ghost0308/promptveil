import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import { generateKey, isPartialPlaceholder, Vault } from "../src/vault.js";
import { cardNumber, openaiKey } from "./fakes.js";

function sample() {
  const key = openaiKey();
  const original = `Hi, I'm jane@example.com. My key is ${key} and my card is ${cardNumber()}. Ring +44 20 7946 0958.`;
  return { original, ...redact(original) };
}

describe("redact and restore", () => {
  it("replaces every value and restores them exactly", () => {
    const { original, text, vault, replacements } = sample();
    expect(text).toBe(
      "Hi, I'm [[EMAIL_1]]. My key is [[SECRET_1]] and my card is [[CARD_1]]. Ring [[PHONE_1]].",
    );
    expect(replacements.map((r) => r.placeholder)).toEqual([
      "[[EMAIL_1]]",
      "[[SECRET_1]]",
      "[[CARD_1]]",
      "[[PHONE_1]]",
    ]);
    expect(JSON.stringify(replacements)).not.toContain("jane@example.com");
    expect(vault.restore(text)).toBe(original);
    expect(vault.size).toBe(4);
  });

  it("gives the same value the same placeholder across messages", () => {
    const first = redact("from a@example.com to b@example.com");
    const second = redact("reply to b@example.com", { vault: first.vault });
    expect(first.text).toBe("from [[EMAIL_1]] to [[EMAIL_2]]");
    expect(second.text).toBe("reply to [[EMAIL_2]]");
  });

  it("never reuses a placeholder that was already in the text", () => {
    const { text, vault } = redact("literal [[EMAIL_1]] and real x@example.com");
    expect(text).toBe("literal [[EMAIL_1]] and real [[EMAIL_2]]");
    expect(vault.restore(text)).toBe("literal [[EMAIL_1]] and real x@example.com");
  });

  it("leaves unknown placeholders alone", () => {
    const vault = new Vault();
    expect(vault.restore("see [[EMAIL_9]] and [[lower_1]]")).toBe(
      "see [[EMAIL_9]] and [[lower_1]]",
    );
  });

  it("supports another placeholder format", () => {
    const vault = new Vault({ prefix: "<", suffix: ">" });
    const { text } = redact("mail z@example.com", { vault });
    expect(text).toBe("mail <EMAIL_1>");
    expect(vault.restore(text)).toBe("mail z@example.com");
  });

  it("rejects formats it couldn't parse back", () => {
    expect(() => new Vault({ prefix: "", suffix: "]" })).toThrow("can't be empty");
    expect(() => new Vault({ prefix: "X", suffix: "]" })).toThrow("must not end or start");
    expect(() => new Vault().placeholderFor("bad", "v")).toThrow("upper-case");
  });
});

describe("streaming restore", () => {
  it("restores placeholders split at every possible point", () => {
    const { original, text, vault } = sample();
    for (let cut = 0; cut <= text.length; cut++) {
      const restorer = vault.restorer();
      const out =
        restorer.push(text.slice(0, cut)) + restorer.push(text.slice(cut)) + restorer.end();
      expect(out).toBe(original);
    }
  });

  it("restores any chunking of the text", () => {
    const { original, text, vault } = sample();
    fc.assert(
      fc.property(fc.array(fc.nat({ max: text.length }), { maxLength: 12 }), (cuts) => {
        const points = [...new Set(cuts)].sort((a, b) => a - b);
        const restorer = vault.restorer();
        let out = "";
        let last = 0;
        for (const point of points) {
          out += restorer.push(text.slice(last, point));
          last = point;
        }
        out += restorer.push(text.slice(last)) + restorer.end();
        return out === original;
      }),
    );
  });

  it("passes any text through unchanged when it has no placeholders", () => {
    const vault = new Vault();
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 8 }), (chunks) => {
        const restorer = vault.restorer();
        return chunks.map((c) => restorer.push(c)).join("") + restorer.end() === chunks.join("");
      }),
    );
  });

  it("holds back only what could still become a placeholder", () => {
    const { vault } = sample();
    const restorer = vault.restorer();
    expect(restorer.push("Write to [[EMA")).toBe("Write to ");
    expect(restorer.push("IL_1]] or [[not a placeholder")).toBe(
      "jane@example.com or [[not a placeholder",
    );
    expect(restorer.end()).toBe("");
  });

  it("works as a TransformStream and over async iterables", async () => {
    const { original, text, vault } = sample();
    const pieces = text.match(/.{1,7}/gs) ?? [];
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    }).pipeThrough(vault.restoreStream());
    let streamed = "";
    for await (const chunk of stream) streamed += chunk;
    expect(streamed).toBe(original);

    async function* source() {
      yield* pieces;
    }
    let iterated = "";
    for await (const chunk of vault.restoreIterable(source())) iterated += chunk;
    expect(iterated).toBe(original);
  });

  // Every format, including ones where the suffix can also start a placeholder,
  // has to stream to exactly what a one-shot restore gives.
  it.each([
    ["[[", "]]"],
    ["<", ">"],
    ["%", "%"],
    ["{{", "}}"],
    ["@@", "@"],
  ])("streams %s...%s the same as a one-shot restore", (prefix, suffix) => {
    const vault = new Vault({ prefix, suffix });
    const placeholders = ["a@x.io", "b@x.io", "k1", "k2"].map((value, i) =>
      vault.placeholderFor(i < 2 ? "EMAIL" : "SECRET", value),
    );
    const piece = fc.constantFrom(...placeholders, prefix, suffix, "EMAIL", "_", "1", " ", "x");
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 30 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        (pieces, rawCuts) => {
          const text = pieces.join("");
          const cuts = [...new Set(rawCuts.map((c) => c % (text.length + 1)))].sort(
            (a, b) => a - b,
          );
          const restorer = vault.restorer();
          let out = "";
          let last = 0;
          for (const cut of cuts) {
            out += restorer.push(text.slice(last, cut));
            last = cut;
          }
          out += restorer.push(text.slice(last)) + restorer.end();
          return out === vault.restore(text);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("restores placeholders that close with the same mark they open with", () => {
    const vault = new Vault({ prefix: "%", suffix: "%" });
    const placeholder = vault.placeholderFor("EMAIL", "a@x.io");
    const restorer = vault.restorer();
    expect(restorer.push(`hi ${placeholder}`)).toBe("hi a@x.io");
    expect(restorer.push(" bye")).toBe(" bye");
    expect(restorer.end()).toBe("");
  });

  it("can restore only some types", async () => {
    const { text, vault } = sample();
    const emailOnly = vault.restore(text, { types: ["EMAIL"] });
    expect(emailOnly).toContain("jane@example.com");
    expect(emailOnly).toContain("[[SECRET_1]]");
    expect(emailOnly).toContain("[[CARD_1]]");
    expect(vault.restore(text, { types: [] })).toBe(text);

    const restorer = vault.restorer({ types: ["PHONE"] });
    const streamed =
      restorer.push(text.slice(0, 40)) + restorer.push(text.slice(40)) + restorer.end();
    expect(streamed).toBe(vault.restore(text, { types: ["PHONE"] }));

    const piped = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    }).pipeThrough(vault.restoreStream({ types: [] }));
    let out = "";
    for await (const chunk of piped) out += chunk;
    expect(out).toBe(text);

    async function* source() {
      yield text;
    }
    let iterated = "";
    for await (const chunk of vault.restoreIterable(source(), { types: ["EMAIL"] })) {
      iterated += chunk;
    }
    expect(iterated).toBe(emailOnly);
  });

  it("recognises partial placeholders", () => {
    for (const partial of ["[", "[[", "[[E", "[[EMAIL", "[[EMAIL_", "[[EMAIL_1", "[[EMAIL_1]"]) {
      expect(isPartialPlaceholder(partial, "[[", "]]")).toBe(true);
    }
    for (const other of ["[[EMAIL_1]]", "[x", "[[e", "[[EMAIL-", "[[EMAIL_x", "[[EMAIL_1)"]) {
      expect(isPartialPlaceholder(other, "[[", "]]")).toBe(false);
    }
  });
});

describe("sealing", () => {
  it("round-trips through AES-256-GCM", async () => {
    const { original, text, vault } = sample();
    const key = generateKey();
    const sealed = await vault.seal(key);
    expect(JSON.stringify(sealed)).not.toContain("example.com");
    const restored = await Vault.unseal(sealed, key);
    expect(restored.restore(text)).toBe(original);
    expect(restored.placeholderFor("EMAIL", "new@example.com")).toBe("[[EMAIL_2]]");
  });

  it("refuses a wrong key, changed data or a bad key size", async () => {
    const { vault } = sample();
    const sealed = await vault.seal(generateKey());
    await expect(Vault.unseal(sealed, generateKey())).rejects.toThrow("wrong key");
    const tampered = { ...sealed, data: `A${sealed.data.slice(1)}` };
    await expect(Vault.unseal(tampered, generateKey())).rejects.toThrow("can't unseal");
    await expect(vault.seal(new Uint8Array(16))).rejects.toThrow("32 bytes");
    await expect(Vault.unseal({ ...sealed, version: 2 as 1 }, generateKey())).rejects.toThrow(
      "unsupported",
    );
  });
});
