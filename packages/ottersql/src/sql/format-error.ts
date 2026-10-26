/**
 * A value's text is not in a format ottersql reads. Its message says why without quoting the
 * value, so a decoding error can pass it on.
 */
export class FormatError extends TypeError {
  override readonly name = "FormatError";
}
