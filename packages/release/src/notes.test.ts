import { describe, expect, test } from "vitest";

import { parseLog, releaseNotes } from "./notes.ts";
import type { Commit } from "./notes.ts";

const repository = "https://github.com/otterfamily/ottersql";

function commit(subject: string, body = ""): Commit {
  return { hash: "0123456789abcdef0123456789abcdef01234567", subject, body };
}

const link = `([0123456](${repository}/commit/0123456789abcdef0123456789abcdef01234567))`;

describe("release notes", () => {
  test("group what users see by kind, breaking changes first, and leave the rest out", () => {
    const commits = [
      commit("feat(cli): show which steps ran"),
      commit("docs: explain expand and contract"),
      commit("fix: keep a valid index left by an earlier run"),
      commit("refactor!: rename the step line", "Old files need the new name."),
      commit("feat: read extensions", "BREAKING CHANGE: the cleanup line changed"),
      commit("perf(catalog): read the catalog in one query"),
      commit("Merge branch 'main'"),
    ];
    expect(releaseNotes(commits, repository)).toBe(
      [
        "## Breaking changes",
        "",
        `- rename the step line ${link}`,
        `- read extensions ${link}`,
        "",
        "## Features",
        "",
        `- **cli:** show which steps ran ${link}`,
        "",
        "## Fixes",
        "",
        `- keep a valid index left by an earlier run ${link}`,
        "",
        "## Performance",
        "",
        `- **catalog:** read the catalog in one query ${link}`,
        "",
      ].join("\n"),
    );
  });

  test("say so when nothing changed for users", () => {
    expect(releaseNotes([commit("test: cover the hint")], repository)).toBe(
      "No changes users see.\n",
    );
  });

  test("read commits from git log, bodies of several lines included", () => {
    const log = "aaa\u001Ffeat: one\u001Fline 1\nline 2\u001E\nbbb\u001Ffix: two\u001F\u001E\n";
    expect(parseLog(log)).toStrictEqual([
      { hash: "aaa", subject: "feat: one", body: "line 1\nline 2" },
      { hash: "bbb", subject: "fix: two", body: "" },
    ]);
  });
});
