/**
 * How far a release moves the version. Before 1.0, users' `^0.y.z` ranges take new patches only,
 * so `minor` is the one for a change that breaks them (semver.org, item 4).
 */
export const bumps = ["patch", "minor", "major"] as const;
export type Bump = (typeof bumps)[number];

const plainVersion = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/v;

/** The version `bump` makes of `version`, a plain `major.minor.patch`; throws on anything else. */
export function nextVersion(version: string, bump: Bump): string {
  const groups = plainVersion.exec(version)?.groups;
  if (groups === undefined) {
    throw new Error(`expected a version such as 1.2.3, not ${JSON.stringify(version)}`);
  }
  const major = Number(groups["major"]);
  const minor = Number(groups["minor"]);
  const patch = Number(groups["patch"]);
  const parts = {
    patch: [major, minor, patch + 1],
    minor: [major, minor + 1, 0],
    major: [major + 1, 0, 0],
  }[bump];
  return parts.join(".");
}

/** The version every package has; they are released together, so they must agree. */
export function sharedVersion(versions: ReadonlyMap<string, string>): string {
  const distinct = new Set(versions.values());
  const [version] = distinct;
  if (version === undefined || distinct.size > 1) {
    const listed = [...versions].map(([name, found]) => `${name} ${found}`).join(", ");
    throw new Error(`the packages are released together, so their versions must match: ${listed}`);
  }
  return version;
}
