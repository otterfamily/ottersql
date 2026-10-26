import type { Transaction } from "../sql/index.ts";
import {
  array,
  boolean,
  CatalogShapeError,
  fields,
  nullable,
  queryRows,
  string,
} from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { scopeParameters, userObject } from "./scope.ts";

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

interface TextSettingsRow {
  readonly collations: readonly CollationRow[];
  readonly configurations: readonly TextSearchConfiguration[];
  readonly dictionaries: readonly TextSearchDictionary[];
}

const textSettingsRow: Shape<TextSettingsRow> = (value, path) => {
  const field = fields(value, path);
  return {
    collations: field("collations", array(collationRow)),
    configurations: field("configurations", array(configurationRow)),
    dictionaries: field("dictionaries", array(dictionaryRow)),
  };
};

const providers = { b: "builtin", c: "libc", d: "default", i: "icu" } as const;

// The ICU or builtin locale is read through to_jsonb because its column was renamed in Postgres
// 17, from `colliculocale` to `colllocale`.
const textSettingsSelect = `select
        coalesce((
          select json_agg(json_build_object(
            'schema', n.nspname, 'name', coll.collname, 'provider', coll.collprovider,
            'deterministic', coll.collisdeterministic,
            'locale', coalesce(to_jsonb(coll)->>'colllocale', to_jsonb(coll)->>'colliculocale'),
            'lcCollate', coll.collcollate, 'lcCtype', coll.collctype
          ) order by n.nspname, coll.collname)
          from pg_collation coll join pg_namespace n on n.oid = coll.collnamespace
          where ${userObject("pg_collation", "coll.oid", "coll.collnamespace")}
        ), '[]') as collations,
        coalesce((
          select json_agg(json_build_object(
            'schema', n.nspname, 'name', cfg.cfgname,
            'parser', (select prsname from pg_ts_parser where oid = cfg.cfgparser),
            'mappings', array(
              select map.maptokentype || ':' || map.mapdict::regdictionary::text
              from pg_ts_config_map map where map.mapcfg = cfg.oid
              order by map.maptokentype, map.mapseqno
            )
          ) order by n.nspname, cfg.cfgname)
          from pg_ts_config cfg join pg_namespace n on n.oid = cfg.cfgnamespace
          where ${userObject("pg_ts_config", "cfg.oid", "cfg.cfgnamespace")}
        ), '[]') as configurations,
        coalesce((
          select json_agg(json_build_object(
            'schema', n.nspname, 'name', dict.dictname,
            'template', (select tmplname from pg_ts_template where oid = dict.dicttemplate),
            'options', dict.dictinitoption
          ) order by n.nspname, dict.dictname)
          from pg_ts_dict dict join pg_namespace n on n.oid = dict.dictnamespace
          where ${userObject("pg_ts_dict", "dict.oid", "dict.dictnamespace")}
        ), '[]') as dictionaries`;

/** The collations, text search configurations and text search dictionaries the user's schemas define, in one query. */
export async function readTextSettings(
  transaction: Transaction,
  omitSchemas: readonly string[],
): Promise<{
  readonly collations: readonly Collation[];
  readonly textSearchConfigurations: readonly TextSearchConfiguration[];
  readonly textSearchDictionaries: readonly TextSearchDictionary[];
}> {
  const [row] = await queryRows(transaction, {
    select: textSettingsSelect,
    row: textSettingsRow,
    label: "collations and text search",
    parameters: scopeParameters(omitSchemas),
  });
  if (row === undefined) {
    throw new CatalogShapeError("the collations and text search query returned no row");
  }
  return {
    collations: row.collations.map((collation) => ({
      ...collation,
      provider: decode(providers, collation.provider, "pg_collation.collprovider"),
    })),
    textSearchConfigurations: row.configurations,
    textSearchDictionaries: row.dictionaries,
  };
}
