import { describe, expect, test } from "vitest";

import { nextVersion, sharedVersion } from "./version.ts";

describe("the next version", () => {
  test.for([
    { version: "0.0.0", bump: "minor", next: "0.1.0" },
    { version: "0.1.9", bump: "patch", next: "0.1.10" },
    { version: "0.1.3", bump: "minor", next: "0.2.0" },
    { version: "0.9.4", bump: "major", next: "1.0.0" },
  ] as const)("of $version after a $bump bump is $next", ({ version, bump, next }) => {
    expect(nextVersion(version, bump)).toBe(next);
  });

  test.for(["1.2", "01.2.3", "1.2.3-beta.1", "v1.2.3"])("is refused for %s", (version) => {
    expect(() => nextVersion(version, "patch")).toThrow(
      `expected a version such as 1.2.3, not "${version}"`,
    );
  });
});

describe("the packages' version", () => {
  test("is the one they all have", () => {
    expect(
      sharedVersion(
        new Map([
          ["a", "0.1.0"],
          ["b", "0.1.0"],
        ]),
      ),
    ).toBe("0.1.0");
  });

  test("is refused when they differ, naming each", () => {
    expect(() =>
      sharedVersion(
        new Map([
          ["a", "0.1.0"],
          ["b", "0.2.0"],
        ]),
      ),
    ).toThrow("the packages are released together, so their versions must match: a 0.1.0, b 0.2.0");
  });
});
