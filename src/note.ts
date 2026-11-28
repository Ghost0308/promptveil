import { DEFAULT_FORMAT, type PlaceholderFormat } from "./vault.js";

/**
 * A short instruction for the model that explains the placeholders, to put in
 * the system prompt. Without it some models remark on the placeholders, or
 * ask for the "real" value, instead of just using them.
 */
/**
 * The note an adapter should add for its `note` option: on by default, `false`
 * or `""` turns it off, and any other string replaces the built-in text.
 * @internal
 */
export function resolveNote(
  option: boolean | string | undefined,
  format: PlaceholderFormat,
): string | undefined {
  if (option === undefined || option === true) return placeholderNote(format);
  return option || undefined;
}

export function placeholderNote(format: PlaceholderFormat = DEFAULT_FORMAT): string {
  const example = `${format.prefix}EMAIL_1${format.suffix}`;
  return (
    `Some values in this conversation have been swapped for placeholders like ${example} to keep them private. ` +
    "The user sees the real values. Wherever you mean one of those values, write its placeholder exactly as it appears. " +
    "Don't mention, explain or ask about the placeholders."
  );
}
