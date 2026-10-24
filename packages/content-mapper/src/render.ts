import type { Catalog, Column, Table, TypeRef } from "@ottersql/catalog";
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
  /** A TypeScript module that declares one typed function per query. */
  readonly text: string;
  /** Where the rendered text came from in the `.sql` file, for diagnostics and go-to-definition. */
  readonly mappings: readonly SpanMapping[];
  readonly diagnostics: readonly MapperDiagnostic[];
}

export const DiagnosticCode = {
  queryFile: 9001,
  postgres: 9002,
  duplicateColumn: 9003,
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
  const context: TypeContext = { catalog, imports: new Set<SqlTypeImport>() };
  const rendered = file.queries.filter((query) => duplicateColumn(query) === null);
  const body = rendered.flatMap((query) => renderQuery(query, context));
  const imports = ["Connection", ...[...context.imports].toSorted()].join(", ");
  const header: Piece = { text: `import type { ${imports} } from "@ottersql/sql";\n` };
  return { ...assemble([header, ...body]), diagnostics: diagnostics(file) };
}

function diagnostics(file: DescribedFile): MapperDiagnostic[] {
  const duplicates = file.queries.flatMap((query) => {
    const duplicate = duplicateColumn(query);
    const message = `Column "${String(duplicate)}" appears more than once; give each column its own name with AS`;
    return duplicate === null
      ? []
      : [diagnostic(message, query.query.nameSpan, DiagnosticCode.duplicateColumn)];
  });
  return [...file.problems.map((problem) => problemDiagnostic(problem)), ...duplicates];
}

function problemDiagnostic(problem: Problem): MapperDiagnostic {
  return diagnostic(problem.message, problem.span, DiagnosticCode[problem.source]);
}

function renderQuery(described: DescribedQuery, context: TypeContext): Piece[] {
  const typeName = pascalCase(described.name);
  const hasParameters = described.parameters.length > 0;
  const params = hasParameters ? `, params: ${typeName}Params` : "";
  return [
    ...(hasParameters ? renderParameters(described, typeName, context) : []),
    { text: `export interface ${typeName}Row { ` },
    ...described.columns.map((column) => ({
      text: `readonly ${propertyName(column.name)}: ${columnType(column, context)}; `,
    })),
    { text: "}\nexport declare function " },
    { text: described.name, original: described.query.nameSpan },
    { text: `(connection: Connection${params}): Promise<${typeName}Row[]>;\n` },
  ];
}

function renderParameters(
  described: DescribedQuery,
  typeName: string,
  context: TypeContext,
): Piece[] {
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
  const domain = catalog.domains.find(
    (candidate) => candidate.schema === declared.schema && candidate.name === declared.name,
  );
  return domain !== undefined && JSON.stringify(domain.baseType) === JSON.stringify(column.type)
    ? declared
    : column.type;
}

function originColumn(
  column: DescribedColumn,
  catalog: Catalog,
): { readonly table: Table; readonly column: Column } | undefined {
  const { origin } = column;
  const table =
    origin === null
      ? undefined
      : catalog.tables.find(
          (candidate) => candidate.schema === origin.schema && candidate.name === origin.table,
        );
  const found = table?.columns.find((candidate) => candidate.name === origin?.column);
  return table === undefined || found === undefined ? undefined : { table, column: found };
}

function duplicateColumn(query: DescribedQuery): string | null {
  const names = query.columns.map(({ name }) => name);
  return names.find((name, index) => names.indexOf(name) !== index) ?? null;
}

function propertyName(name: string): string {
  return /^[\p{L}$_][\p{L}\p{N}$_]*$/v.test(name) ? name : JSON.stringify(name);
}

function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function diagnostic(messageText: string, span: Span, code: number): MapperDiagnostic {
  return { messageText, start: span.start, length: span.length, code };
}
