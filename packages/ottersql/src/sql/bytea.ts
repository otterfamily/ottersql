import { FormatError } from "./format-error.ts";

// The hex format of bytea (`\x00ff`): Postgres writes it by default and reads it whatever its settings.
const PREFIX = String.raw`\x`;

export function byteaText(bytes: Uint8Array): string {
  return PREFIX + bytes.toHex();
}

/** Only the hex format: reading `bytea_output = escape` text as hex would corrupt it. */
export function byteaBytes(text: string): Uint8Array {
  if (!text.startsWith(PREFIX)) {
    throw new FormatError("not bytea in the hex output format");
  }
  try {
    return Uint8Array.fromHex(text.slice(PREFIX.length));
  } catch {
    throw new FormatError("not bytea in the hex output format");
  }
}
