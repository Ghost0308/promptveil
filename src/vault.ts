// The vault maps sensitive values to placeholders and back.

export interface PlaceholderFormat {
  /** Text before the TYPE_N part. Default "[[". */
  readonly prefix: string;
  /** Text after it. Default "]]". */
  readonly suffix: string;
}

export const DEFAULT_FORMAT: PlaceholderFormat = { prefix: "[[", suffix: "]]" };

export interface RestoreOptions {
  /**
   * Only put back values of these placeholder types, like ["EMAIL"]. Other
   * placeholders stay as they are. Leave it out to restore everything.
   */
  readonly types?: readonly string[];
  /**
   * Applied to each value as it goes back in. Use `escapeJsonString` when the
   * text is JSON, so a value with a quote or backslash can't break out of its string.
   */
  readonly encode?: (value: string) => string;
}

/** `value` escaped to sit inside a JSON string, for `RestoreOptions.encode`. */
export function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** A vault encrypted with AES-256-GCM. Safe to store, useless without the key. */
export interface SealedVault {
  readonly version: 1;
  readonly alg: "A256GCM";
  readonly iv: string;
  readonly data: string;
}

interface VaultState {
  prefix: string;
  suffix: string;
  counters: [string, number][];
  entries: [string, string][];
}

// Placeholder type names are upper-case letters and digits; at most this long in the stream.
const MAX_TYPE = 32;
const MAX_DIGITS = 9;
const SEAL_CONTEXT = new TextEncoder().encode("promptveil-vault-v1");

export class Vault {
  readonly format: PlaceholderFormat;
  readonly #placeholderByValue = new Map<string, string>();
  readonly #valueByPlaceholder = new Map<string, string>();
  readonly #counters = new Map<string, number>();
  readonly #pattern: RegExp;

  constructor(format: PlaceholderFormat = DEFAULT_FORMAT) {
    if (format.prefix.length === 0 || format.suffix.length === 0) {
      throw new Error("placeholder prefix and suffix can't be empty");
    }
    if (/[A-Z0-9_]/.test(format.prefix.at(-1) ?? "") || /[A-Z0-9_]/.test(format.suffix[0] ?? "")) {
      throw new Error("placeholder prefix and suffix must not end or start with A-Z, 0-9 or _");
    }
    this.format = format;
    this.#pattern = placeholderPattern(format);
  }

  /** How many distinct values the vault holds. */
  get size(): number {
    return this.#valueByPlaceholder.size;
  }

  /**
   * The placeholder for `value`, making one if needed. The same value always
   * gets the same placeholder. A new placeholder never matches text already
   * in `context`, so restoring can't touch text that was there all along.
   */
  placeholderFor(type: string, value: string, context = ""): string {
    const existing = this.#placeholderByValue.get(value);
    if (existing !== undefined) return existing;
    if (!/^[A-Z][A-Z0-9]*$/.test(type) || type.length > MAX_TYPE) {
      throw new Error(`placeholder type '${type}' must be upper-case letters and digits`);
    }
    let n = this.#counters.get(type) ?? 0;
    let placeholder: string;
    do {
      n += 1;
      placeholder = `${this.format.prefix}${type}_${n}${this.format.suffix}`;
    } while (this.#valueByPlaceholder.has(placeholder) || context.includes(placeholder));
    this.#counters.set(type, n);
    this.#placeholderByValue.set(value, placeholder);
    this.#valueByPlaceholder.set(placeholder, value);
    return placeholder;
  }

  /** `text` with every placeholder this vault knows swapped back for its value. */
  restore(text: string, options: RestoreOptions = {}): string {
    const types = options.types === undefined ? undefined : new Set(options.types);
    const { encode } = options;
    return text.replace(this.#pattern, (whole, id: string) => {
      if (types !== undefined && !types.has(id.slice(0, id.lastIndexOf("_")))) return whole;
      const value = this.#valueByPlaceholder.get(whole);
      if (value === undefined) return whole;
      return encode === undefined ? value : encode(value);
    });
  }

  /** A restorer for text that arrives in pieces. */
  restorer(options: RestoreOptions = {}): StreamRestorer {
    return new StreamRestorer(this, options);
  }

  /** A TransformStream that restores placeholders in streamed text. */
  restoreStream(options: RestoreOptions = {}): TransformStream<string, string> {
    const restorer = this.restorer(options);
    return new TransformStream<string, string>({
      transform(chunk, controller) {
        const out = restorer.push(chunk);
        if (out) controller.enqueue(out);
      },
      flush(controller) {
        const out = restorer.end();
        if (out) controller.enqueue(out);
      },
    });
  }

  /** Restore an async iterable of text chunks, such as an SDK's text stream. */
  async *restoreIterable(
    chunks: AsyncIterable<string>,
    options: RestoreOptions = {},
  ): AsyncGenerator<string> {
    const restorer = this.restorer(options);
    for await (const chunk of chunks) {
      const out = restorer.push(chunk);
      if (out) yield out;
    }
    const rest = restorer.end();
    if (rest) yield rest;
  }

  /** Encrypt the vault with a 32-byte key, for storing it between requests. */
  async seal(key: Uint8Array): Promise<SealedVault> {
    const state: VaultState = {
      prefix: this.format.prefix,
      suffix: this.format.suffix,
      counters: [...this.#counters],
      entries: [...this.#valueByPlaceholder],
    };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: SEAL_CONTEXT },
      await importKey(key),
      new TextEncoder().encode(JSON.stringify(state)),
    );
    return { version: 1, alg: "A256GCM", iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
  }

  /** Decrypt a sealed vault. Throws if the key is wrong or the data was changed. */
  static async unseal(sealed: SealedVault, key: Uint8Array): Promise<Vault> {
    if (sealed.version !== 1 || sealed.alg !== "A256GCM") {
      throw new Error("unsupported sealed vault format");
    }
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: SEAL_CONTEXT },
        await importKey(key),
        fromBase64(sealed.data),
      );
    } catch {
      throw new Error("can't unseal the vault: wrong key, or the data was changed");
    }
    const state = JSON.parse(new TextDecoder().decode(plain)) as VaultState;
    const vault = new Vault({ prefix: state.prefix, suffix: state.suffix });
    for (const [type, n] of state.counters) vault.#counters.set(type, n);
    for (const [placeholder, value] of state.entries) {
      vault.#valueByPlaceholder.set(placeholder, value);
      vault.#placeholderByValue.set(value, placeholder);
    }
    return vault;
  }

  /** @internal Used by StreamRestorer to know how far a partial placeholder can reach. */
  get maxPlaceholderLength(): number {
    return this.format.prefix.length + MAX_TYPE + 1 + MAX_DIGITS + this.format.suffix.length;
  }
}

/**
 * Restores placeholders in text that arrives in pieces. When a chunk ends partway
 * through something that could still become a placeholder, that tail is held back
 * until the next chunk shows whether it is one.
 */
export class StreamRestorer {
  readonly #vault: Vault;
  readonly #options: RestoreOptions;
  readonly #pattern: RegExp;
  #buffer = "";

  constructor(vault: Vault, options: RestoreOptions = {}) {
    this.#vault = vault;
    this.#options = options;
    this.#pattern = placeholderPattern(vault.format);
  }

  push(chunk: string): string {
    this.#buffer += chunk;
    const hold = this.#holdFrom();
    const ready = this.#buffer.slice(0, hold);
    this.#buffer = this.#buffer.slice(hold);
    return this.#vault.restore(ready, this.#options);
  }

  end(): string {
    const rest = this.#vault.restore(this.#buffer, this.#options);
    this.#buffer = "";
    return rest;
  }

  /**
   * Where the held-back tail starts: the first spot that could still grow into a
   * placeholder. Whole placeholders are skipped, because with a format like %X_1%
   * the closing % would otherwise look like the start of the next one.
   */
  #holdFrom(): number {
    const buffer = this.#buffer;
    const { prefix, suffix } = this.#vault.format;
    const from = Math.max(0, buffer.length - this.#vault.maxPlaceholderLength);
    const whole: [number, number][] = [];
    for (const match of buffer.matchAll(this.#pattern)) {
      const end = match.index + match[0].length;
      if (end > from) whole.push([match.index, end]);
    }
    let next = 0;
    for (let i = from; i < buffer.length; i++) {
      while (next < whole.length && (whole[next] as [number, number])[1] <= i) next++;
      const span = whole[next];
      if (span !== undefined && i >= span[0]) {
        i = span[1] - 1;
        continue;
      }
      if (buffer[i] === prefix[0] && isPartialPlaceholder(buffer.slice(i), prefix, suffix))
        return i;
    }
    return buffer.length;
  }
}

function placeholderPattern(format: PlaceholderFormat): RegExp {
  return new RegExp(
    `${escapeRegExp(format.prefix)}([A-Z][A-Z0-9]*_\\d+)${escapeRegExp(format.suffix)}`,
    "g",
  );
}

/** True when `text` is the start of a placeholder but not yet a whole one. */
export function isPartialPlaceholder(text: string, prefix: string, suffix: string): boolean {
  let i = 0;
  for (const char of prefix) {
    if (i === text.length) return true;
    if (text[i] !== char) return false;
    i++;
  }
  if (i === text.length) return true;
  if (!/[A-Z]/.test(text[i] as string)) return false;
  while (i < text.length && /[A-Z0-9]/.test(text[i] as string)) i++;
  if (i === text.length) return true;
  if (text[i] !== "_") return false;
  i++;
  if (i === text.length) return true;
  if (!/\d/.test(text[i] as string)) return false;
  while (i < text.length && /\d/.test(text[i] as string)) i++;
  for (const char of suffix) {
    if (i === text.length) return true;
    if (text[i] !== char) return false;
    i++;
  }
  return false;
}

/** 32 random bytes for sealing vaults. */
export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error("the vault key must be 32 bytes");
  // Copy into a plain ArrayBuffer-backed array, which is what WebCrypto accepts.
  return crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
