import type { Routine } from "./routines.ts";
import type { Comment } from "./shared.ts";
import type { Sequence, Table } from "./table.ts";
import type { CompositeType, Domain, Enum, RangeType } from "./types.ts";
import type { View } from "./views.ts";

export interface Catalog {
  readonly capabilities: Capabilities;
  readonly schemas: readonly Schema[];
  readonly extensions: readonly InstalledExtension[];
  readonly tables: readonly Table[];
  /** Sequences no column owns; those of `serial` columns are read with them. */
  readonly sequences: readonly Sequence[];
  readonly enums: readonly Enum[];
  readonly composites: readonly CompositeType[];
  readonly collations: readonly Collation[];
  readonly textSearchConfigurations: readonly TextSearchConfiguration[];
  readonly textSearchDictionaries: readonly TextSearchDictionary[];
  readonly ranges: readonly RangeType[];
  readonly domains: readonly Domain[];
  readonly views: readonly View[];
  readonly routines: readonly Routine[];
}

/** What the database the catalog was read from supports. */
export interface Capabilities {
  readonly engine: "postgres";
  readonly version: { readonly major: number; readonly minor: number };
}

/** A schema the user's objects live in, `public` included. */
export interface Schema {
  readonly name: string;
  readonly comment: Comment | null;
}

/**
 * An extension installed in the database, by the schema it was installed into. Its version is left
 * out: PGlite and a server can ship different versions of the same extension.
 */
export interface InstalledExtension {
  readonly schema: string;
  readonly name: string;
}

/** A collation `CREATE COLLATION` makes. */
export interface Collation {
  readonly schema: string;
  readonly name: string;
  readonly provider: "default" | "libc" | "icu" | "builtin";
  readonly deterministic: boolean;
  /** The ICU or builtin locale; `null` for libc, which has `lcCollate` and `lcCtype` instead. */
  readonly locale: string | null;
  readonly lcCollate: string | null;
  readonly lcCtype: string | null;
}

/** A text search configuration: its parser, and the dictionaries of each token type in order. */
export interface TextSearchConfiguration {
  readonly schema: string;
  readonly name: string;
  readonly parser: string;
  /** `tokentype:dictionary`, by token type number and then in the order they are tried. */
  readonly mappings: readonly string[];
}

/** A text search dictionary: the template it is made from and the options it is given. */
export interface TextSearchDictionary {
  readonly schema: string;
  readonly name: string;
  readonly template: string;
  readonly options: string | null;
}
