import { array, boolean, catalogRead, fields, nullable, string } from "./catalog-json.ts";
import type { CatalogRead, Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { userObject } from "./scope.ts";

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

interface CollationRow extends Omit<Collation, "provider"> {
  readonly provider: string;
}

const collationRow: Shape<CollationRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    provider: field("provider", string),
    deterministic: field("deterministic", boolean),
    locale: field("locale", nullable(string)),
    lcCollate: field("lcCollate", nullable(string)),
    lcCtype: field("lcCtype", nullable(string)),
  };
};

const configurationRow: Shape<TextSearchConfiguration> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    parser: field("parser", string),
    mappings: field("mappings", array(string)),
  };
};

const dictionaryRow: Shape<TextSearchDictionary> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    template: field("template", string),
    options: field("options", nullable(string)),
  };
};

const providers = { b: "builtin", c: "libc", d: "default", i: "icu" } as const;

// The ICU or builtin locale is read through to_jsonb because its column was renamed in Postgres
// 17, from `colliculocale` to `colllocale`.
export const collationsRead: CatalogRead<readonly Collation[]> = catalogRead(
  {
    select: `select n.nspname as schema, coll.collname as name, coll.collprovider as provider,
        coll.collisdeterministic as deterministic,
        coalesce(to_jsonb(coll)->>'colllocale', to_jsonb(coll)->>'colliculocale') as locale,
        coll.collcollate as "lcCollate", coll.collctype as "lcCtype"
      from pg_collation coll join pg_namespace n on n.oid = coll.collnamespace
      where ${userObject("pg_collation", "coll.oid", "coll.collnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: collationRow,
    label: "collations",
  },
  (rows) =>
    rows.map((collation) => ({
      ...collation,
      provider: decode(providers, collation.provider, "pg_collation.collprovider"),
    })),
);

export const textSearchConfigurationsRead: CatalogRead<readonly TextSearchConfiguration[]> =
  catalogRead(
    {
      select: `select n.nspname as schema, cfg.cfgname as name,
          (select prsname from pg_ts_parser where oid = cfg.cfgparser) as parser,
          array(
            select map.maptokentype || ':' || map.mapdict::regdictionary::text
            from pg_ts_config_map map where map.mapcfg = cfg.oid
            order by map.maptokentype, map.mapseqno
          ) as mappings
        from pg_ts_config cfg join pg_namespace n on n.oid = cfg.cfgnamespace
        where ${userObject("pg_ts_config", "cfg.oid", "cfg.cfgnamespace")}`,
      orderBy: "rows.schema, rows.name",
      row: configurationRow,
      label: "text search configurations",
    },
    (rows) => rows,
  );

export const textSearchDictionariesRead: CatalogRead<readonly TextSearchDictionary[]> = catalogRead(
  {
    select: `select n.nspname as schema, dict.dictname as name,
          (select tmplname from pg_ts_template where oid = dict.dicttemplate) as template,
          dict.dictinitoption as options
        from pg_ts_dict dict join pg_namespace n on n.oid = dict.dictnamespace
        where ${userObject("pg_ts_dict", "dict.oid", "dict.dictnamespace")}`,
    orderBy: "rows.schema, rows.name",
    row: dictionaryRow,
    label: "text search dictionaries",
  },
  (rows) => rows,
);
