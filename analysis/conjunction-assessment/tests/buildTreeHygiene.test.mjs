import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
const packagePath = path
  .relative(repositoryRoot, packageRoot)
  .split(path.sep)
  .join("/");

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

test("CMake build-* scratch trees are never tracked", () => {
  const tracked = git([
    "ls-files",
    "--",
    `${packagePath}/src/cpp/build-*`,
  ])
    .split("\n")
    .filter(Boolean);

  assert.deepEqual(
    tracked,
    [],
    `generated CMake build tree paths must not be versioned:\n${tracked.join("\n")}`,
  );
});

test("future CMake build-* scratch trees are ignored", () => {
  const probe = `${packagePath}/src/cpp/build-hygiene-probe/nested/object.o`;
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", "--", probe],
    { cwd: repositoryRoot },
  );

  assert.equal(
    result.status,
    0,
    `${probe} must be ignored by the package .gitignore`,
  );
});
