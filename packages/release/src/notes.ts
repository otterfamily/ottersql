/** A commit as `git log` prints it with `logFormat`. */
export interface Commit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

const field = "\u001F";
const record = "\u001E";

/** The `git log --format` that `parseLog` reads: fields and records split by control characters. */
export const logFormat = "%H%x1F%s%x1F%b%x1E";

export function parseLog(log: string): Commit[] {
  return log
    .split(record)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [hash = "", subject = "", body = ""] = entry.split(field);
      return { hash, subject, body };
    });
}

// A Conventional Commits header: type, optional scope, `!` for a breaking change, description.
const header = /^(?<type>[a-z]+)(?:\((?<scope>[^\(\)]+)\))?(?<breaking>!)?: (?<description>.+)$/v;

interface Section {
  readonly title: string;
  /** The commit types listed in it; a breaking change of any type goes first, in its own. */
  readonly types: readonly string[];
}

const breakingChanges = "Breaking changes";
const sections: readonly Section[] = [
  { title: breakingChanges, types: [] },
  { title: "Features", types: ["feat"] },
  { title: "Fixes", types: ["fix"] },
  { title: "Performance", types: ["perf"] },
];

interface Entry {
  readonly section: string;
  readonly line: string;
}

// The length GitHub abbreviates a commit hash to.
const shortHash = 7;

/** The section a commit with the header `groups` and `body` is listed in, if any. */
function sectionOf(
  groups: Readonly<Record<string, string | undefined>>,
  body: string,
): string | null {
  const type = groups["type"] ?? "";
  if (groups["breaking"] !== undefined || /^BREAKING[ \-]CHANGE: /mv.test(body)) {
    return breakingChanges;
  }
  return sections.find(({ types }) => types.includes(type))?.title ?? null;
}

function entryOf(commit: Commit, repository: string): Entry | null {
  const groups = header.exec(commit.subject)?.groups;
  const description = groups?.["description"];
  const section = groups === undefined ? null : sectionOf(groups, commit.body);
  if (description === undefined || section === null) {
    return null;
  }
  const scope = groups?.["scope"];
  const link = `[${commit.hash.slice(0, shortHash)}](${repository}/commit/${commit.hash})`;
  return {
    section,
    line: `- ${scope === undefined ? "" : `**${scope}:** `}${description} (${link})`,
  };
}

/**
 * Release notes for `commits`, newest first as `git log` lists them, grouped by what they mean to
 * users. Commits of other types (docs, tests, refactors, build) change nothing users see.
 */
export function releaseNotes(commits: readonly Commit[], repository: string): string {
  const entries = commits.flatMap((commit) => entryOf(commit, repository) ?? []);
  const written = sections.flatMap(({ title }) => {
    const lines = entries.filter(({ section }) => section === title).map(({ line }) => line);
    return lines.length === 0 ? [] : [`## ${title}\n\n${lines.join("\n")}\n`];
  });
  return written.length === 0 ? "No changes users see.\n" : written.join("\n");
}
