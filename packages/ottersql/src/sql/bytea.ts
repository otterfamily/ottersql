import { FormatError } from "./format-error.ts";
// The hex format of bytea (`\x00ff`): Postgres writes it by default and reads it whatever its settings.
const PREFIX = String.raw`\x`;
const HEX = 16;
const DIGITS_PER_BYTE = 2;
const hexText = /^\\x(?:[\da-f]{2})*$/v;

export function byteaText(bytes: Uint8Array): string {
  return (
    PREFIX + [...bytes].map((byte) => byte.toString(HEX).padStart(DIGITS_PER_BYTE, "0")).join("")
  );
}

/** Only the hex format: reading `bytea_output = escape` text as hex would corrupt it. */
export function byteaBytes(text: string): Uint8Array {
  if (!hexText.test(text)) {
    throw new FormatError("not bytea in the hex output format");
  }
  const bytes = new Uint8Array((text.length - PREFIX.length) / DIGITS_PER_BYTE);
  for (let index = 0; index < bytes.length; index += 1) {
    const start = PREFIX.length + index * DIGITS_PER_BYTE;
    bytes[index] = Number.parseInt(text.slice(start, start + DIGITS_PER_BYTE), HEX);
  }
  return bytes;
}
