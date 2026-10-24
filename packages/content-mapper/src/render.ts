import { findDomain, findTable, sameType } from "@ottersql/catalog";
import type { Catalog, Column, Table, TypeRef } from "@ottersql/catalog";
import { columnNamesProblem, isIdentifier } from "@ottersql/sql";
import type { Span } from "@ottersql/sql";

import type { DescribedColumn, DescribedFile, DescribedQuery, Problem } from "./session.ts";
import { literalUnion, nullable, tsType } from "./typescript-types.ts";
import type { SqlTypeImport, TypeContext } from "./typescript-types.ts";

/** `[virtualStart, virtualLength, originalStart, originalLength, kind]`, as TypeScript's content mapper protocol defines it. */
export type SpanMapping = readonly [number, number, number, number, number];

export interface MapperDiagnostic {
  readonly messageText: string;
  readonly start: number;
  readonly length: number;
  readonly code: number;
}

export interface RenderedFile {
  /** A TypeScript module that declares one typed query per query. */
  readonly text: string;
  /** Where the rendered text came from in the `.sql` file, for diagnostics and go-to-definition. */
  readonly mappings: readonly SpanMapping[];
  readonly diagnostics: readonly MapperDiagnostic[];
}

export const DiagnosticCode = {
  queryFile: 9001,
  postgres: 9002,
  unrenderable: 9003,
  schema: 9004,
} as const;

/** Rendered text and, when it stands for something written in the `.sql` file, where. */
interface Piece {
  readonly text: string;
  readonly original?: Span;
}

const VERBATIM = 0;

/** Renders a described `.sql` file as the TypeScript module its importers see. */
export function renderFile(file: DescribedFile, catalog: Catalog): RenderedFile {
  const context: TypeContext = { catalog, direction: "output", imports: new Set<SqlTypeImport>() };
  const rejected = rejectedQueries(file.queries);
  const body = file.queries
    .filter((query) => !rejected.has(query))
    .flatMap((query) => renderQuery(query, context));
  const imports = [...context.imports, "TypedQuery"].toSorted().join(", ");
  const header: Piece = { text: `import type { ${imports} } from "@ottersql/sql";\n` };
  return {
    ...assemble([header, ...body]),
    diagnostics: [
      ...file.problems.map((problem) => problemDiagnostic(problem)),
      ...[...rejected].map(([query, message]) =>
        diagnostic(message, query.query.nameSpan, DiagnosticCode.unrenderable),
      ),
    ],
  };
}

// Every type a rendered module may import from @ottersql/sql.
const importedTypes: ReadonlySet<string> = new Set(["Interval", "Json", "Range", "TypedQuery"]);

/** Queries whose declarations would not compile, with the reason for each. */
function rejectedQueries(queries: readonly DescribedQuery[]): Map<DescribedQuery, string> {
  const rejected = new Map<DescribedQuery, string>();
  const typeOwners = new Map<string, string>();
  for (const query of queries) {
    const typeName = pascalCase(query.name);
    const reason = rejection(query, typeOwners.get(typeName));
    if (reason !== null) {
      rejected.set(query, reason);
    }
    typeOwners.set(typeName, typeOwners.get(typeName) ?? query.name);
  }
  return rejected;
}

/** Why `query` cannot be declared, given the query that already owns its type names, if any. */
function rejection(query: DescribedQuery, typeOwner: string | undefined): string | null {
  const { name } = query;
  if (importedTypes.has(name)) {
    return `Query "${name}" would clash with the ${name} type the module imports`;
  }
  if (typeOwner !== undefined) {
    const typeName = pascalCase(name);
    return `Query "${name}" would declare the same ${typeName}Params and ${typeName}Row types as query "${typeOwner}"`;
  }
  return columnNamesProblem(query.columns.map((column) => column.name));
}

function problemDiagnostic(problem: Problem): MapperDiagnostic {
  return diagnostic(problem.message, problem.span, DiagnosticCode[problem.source]);
}

function renderQuery(described: DescribedQuery, context: TypeContext): Piece[] {
  const typeName = pascalCase(described.name);
  const hasParameters = described.parameters.length > 0;
  const params = hasParameters ? `${typeName}Params` : "undefined";
  return [
    ...(hasParameters ? renderParameters(described, typeName, context) : []),
    { text: `export interface ${typeName}Row { ` },
    ...described.columns.map((column) => ({
      text: `readonly ${propertyName(column.name)}: ${columnType(column, context)}; `,
    })),
    { text: "}\nexport declare const " },
    { text: described.name, original: described.query.nameSpan },
    { text: `: TypedQuery<${params}, ${typeName}Row>;\n` },
  ];
}

function renderParameters(
  described: DescribedQuery,
  typeName: string,
  outputs: TypeContext,
): Piece[] {
  const context: TypeContext = { ...outputs, direction: "input" };
  return [
    { text: `export interface ${typeName}Params { ` },
    ...described.parameters.flatMap((parameter, index): Piece[] => {
      const [firstUse] = described.query.parameters[index]?.spans ?? [];
      const name: Piece =
        firstUse === undefined
          ? { text: parameter.name }
          : {
              text: parameter.name,
              original: { start: firstUse.start + ":".length, length: parameter.name.length },
            };
      return [
        { text: "readonly " },
        name,
        { text: `: ${nullable(tsType(parameter.type, context))}; ` },
      ];
    }),
    { text: "}\n" },
  ];
}

function assemble(pieces: readonly Piece[]): Pick<RenderedFile, "text" | "mappings"> {
  let text = "";
  const mappings: SpanMapping[] = [];
  for (const piece of pieces) {
    if (piece.original !== undefined) {
      mappings.push([
        text.length,
        piece.text.length,
        piece.original.start,
        piece.original.length,
        VERBATIM,
      ]);
    }
    text += piece.text;
  }
  return { text, mappings };
}

function columnType(column: DescribedColumn, context: TypeContext): string {
  const origin = originColumn(column, context.catalog);
  const allowed = origin?.table.checks.find(
    (check) => check.allowedValues?.column === origin.column.name,
  )?.allowedValues?.values;
  const type =
    allowed === undefined
      ? tsType(declaredType(column, origin?.column, context.catalog), context)
      : literalUnion(allowed);
  return column.nullable ? nullable(type) : type;
}

/**
 * Postgres reports a domain column's result type as the domain's base type. When the column comes
 * straight from a table column of that domain, the domain's type is the more precise truth: a cast
 * to the base type keeps the value, so the domain's checks still hold.
 */
function declaredType(
  column: DescribedColumn,
  origin: Column | undefined,
  catalog: Catalog,
): TypeRef {
  const declared = origin?.type;
  if (declared?.kind !== "domain") {
    return column.type;
  }
  const domain = findDomain(catalog, declared.schema, declared.name);
  return domain !== undefined && sameType(domain.baseType, column.type) ? declared : column.type;
}

function originColumn(
  column: DescribedColumn,
  catalog: Catalog,
): { readonly table: Table; readonly column: Column } | undefined {
  const { origin } = column;
  const table = origin === null ? undefined : findTable(catalog, origin.schema, origin.table);
  const found = table?.columns.find((candidate) => candidate.name === origin?.column);
  return table === undefined || found === undefined ? undefined : { table, column: found };
}

function propertyName(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function diagnostic(messageText: string, span: Span, code: number): MapperDiagnostic {
  return { messageText, start: span.start, length: span.length, code };
}
