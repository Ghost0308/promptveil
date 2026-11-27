// Fake secrets, built at runtime.
//
// No file in this repo spells out a whole key in a real format, so gitleaks and
// GitHub push protection never see one. Prefixes are split up for the same reason.

let state = 20261127;

/** A small seeded generator, so test data is the same on every run. */
function random(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
export const ALNUM = LOWER + UPPER + DIGITS;
const URLSAFE = `${ALNUM}_-`;
const HEX = `${DIGITS}abcdef`;

/** Random characters that always mix letters and digits when the alphabet has both. */
export function chars(n: number, alphabet = ALNUM): string {
  const hasLetters = /[A-Za-z]/.test(alphabet);
  const hasDigits = /\d/.test(alphabet);
  for (;;) {
    let value = "";
    for (let i = 0; i < n; i++) value += alphabet[Math.floor(random() * alphabet.length)];
    if ((!hasLetters || /[A-Za-z]/.test(value)) && (!hasDigits || /\d/.test(value))) return value;
  }
}

export interface Sample {
  readonly text: string;
  readonly secret: string;
}

const plain = (make: () => string) => (): Sample => {
  const value = make();
  return { text: value, secret: value };
};

const inContext =
  (before: string, make: () => string, after = "") =>
  (): Sample => {
    const value = make();
    return { text: before + value + after, secret: value };
  };

/** One generator per rule in rules.json, keyed by rule id. */
export const SAMPLES: Record<string, () => Sample> = {
  "openai-key": plain(() => `sk-${"proj-"}${chars(64, URLSAFE)}`),
  "openai-legacy-key": plain(() => `sk-${chars(20)}T3Blbk${"FJ"}${chars(20)}`),
  "anthropic-key": plain(() => `sk-${"ant-"}api03-${chars(93, URLSAFE)}AA`),
  "openrouter-key": plain(() => `sk-${"or-v1-"}${chars(64, HEX)}`),
  "sk-style-key": plain(() => `sk-${chars(48)}`),
  "google-api-key": plain(() => `AI${"za"}${chars(35, URLSAFE)}`),
  "google-oauth-token": plain(() => `ya29${"."}${chars(120, URLSAFE)}`),
  "groq-key": plain(() => `gsk${"_"}${chars(52)}`),
  "xai-key": plain(() => `xai${"-"}${chars(80)}`),
  "huggingface-token": plain(() => `hf${"_"}${chars(34)}`),
  "perplexity-key": plain(() => `pplx${"-"}${chars(48)}`),
  "replicate-token": plain(() => `r8${"_"}${chars(37)}`),
  "fireworks-key": plain(() => `fw${"_"}${chars(24)}`),
  "nvidia-key": plain(() => `nvapi${"-"}${chars(64, URLSAFE)}`),
  "langsmith-key": plain(() => `lsv2${"_pt_"}${chars(32, HEX)}_${chars(10, HEX)}`),
  "aws-access-key-id": plain(() => `AK${"IA"}${chars(16, UPPER + DIGITS)}`),
  "aws-bedrock-api-key": plain(() => `AB${"SK"}${chars(100, `${ALNUM}+/`)}`),
  "github-token": plain(() => `gh${"p_"}${chars(36)}`),
  "github-fine-grained-token": plain(() => `github${"_pat_"}${chars(22)}_${chars(59)}`),
  "slack-token": plain(() => `xo${"xb-"}${chars(12, DIGITS)}-${chars(12, DIGITS)}-${chars(24)}`),
  "stripe-live-key": plain(() => `sk${"_live_"}${chars(24)}`),
  "private-key": plain(() => `-----BEGIN ${"RSA PRIVATE"} KEY-----`),
  jwt: plain(() => `ey${"J"}${chars(30, URLSAFE)}.ey${"J"}${chars(40, URLSAFE)}.${chars(43)}`),
  "url-credentials": inContext("postgres://app:", () => chars(20), "@db.internal:5432/main"),
  "bearer-token": inContext("Authorization: Bearer ", () => chars(40)),
  "secret-assignment": inContext('{"api_key": "', () => chars(32), '"}'),
};

export const openaiKey = (): string => (SAMPLES["openai-key"] as () => Sample)().secret;

/** A card number with a valid Luhn check digit, built from random digits. */
export function cardNumber(length = 16): string {
  const body = chars(length - 1, DIGITS);
  for (let check = 0; check <= 9; check++) {
    const candidate = `${body}${check}`;
    let sum = 0;
    for (let i = 0; i < candidate.length; i++) {
      let digit = Number(candidate[candidate.length - 1 - i]);
      if (i % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error("unreachable");
}
