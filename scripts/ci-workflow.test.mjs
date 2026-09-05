import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const e2eWorkflowPath = new URL(".github/workflows/e2e.yml", repoRoot);
const desktopReleaseWorkflowPath = new URL(".github/workflows/desktop-release.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

// The pull-request gate. The browser and desktop suites are deliberately not here; they
// run in e2e.yml on a schedule, and the test below keeps them from being dropped instead.
const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["quality", { name: "quality", contract: "quality" }],
  ["server-tests", { name: "server-tests", contract: "server" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["cli-tests", { name: "cli-tests", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;
  const lines = source.split("\n");
  const jobsIndex = lines.indexOf("jobs:");
  assert.notEqual(jobsIndex, -1, "workflow has no jobs section");

  for (const line of lines.slice(jobsIndex + 1)) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.doesNotMatch(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);
  assert.match(jobs.get("changes")?.join("\n") ?? "", /github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(
    jobs.get("changes")?.join("\n") ?? "",
    /github\.event_name != 'pull_request'/,
  );
  assert.deepEqual([...jobs.keys()], ["changes", ...gatedCiJobs.keys()]);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  assert.doesNotMatch(
    source,
    /\$\{\{\s*always\(\)/,
    "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
  );
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));
  assert.equal(desktop, "");
});

test("the browser and desktop suites still run, on a schedule rather than per pull request", () => {
  const source = readFileSync(e2eWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const trigger = source.split("jobs:", 1)[0];

  // Scheduled, never on pull_request: that is the whole point of moving them here.
  assert.match(trigger, /^\s+schedule:$/m);
  assert.match(trigger, /^\s+- cron: /m);
  assert.match(trigger, /^\s+workflow_dispatch:$/m);
  assert.doesNotMatch(trigger, /^\s+pull_request:$/m);

  assert.deepEqual([...jobs.keys()], ["desktop-tests", "playwright"]);

  const desktop = jobs.get("desktop-tests")?.join("\n") ?? "";
  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);

  // Sharded, or the browser suite is a single hour-long job again.
  const playwright = jobs.get("playwright")?.join("\n") ?? "";
  assert.match(playwright, /shard: \[1, 2, 3, 4\]/);
  assert.match(playwright, /--shard=\$\{\{ matrix\.shard \}\}\/4/);
  assert.match(playwright, /npm run test:e2e --workspace=@getpaseo\/app/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("CI routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    server: ["packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: ["packages/client/**", "packages/highlight/**", "packages/protocol/**"],
    browser: [
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("the fork only keeps owned GitHub and EAS automation", () => {
  const workflowFiles = readdirSync(new URL(".github/workflows/", repoRoot)).sort();
  assert.deepEqual(workflowFiles, [
    "ci.yml",
    "desktop-release.yml",
    "desktop-rollout.yml",
    "e2e.yml",
    "fork-upstream-drift.yml",
    "release-notes-sync.yml",
  ]);

  const easWorkflows = new URL("packages/app/.eas/workflows/", repoRoot);
  const easWorkflowFiles = existsSync(easWorkflows)
    ? readdirSync(easWorkflows).filter((path) => /\.ya?ml$/.test(path))
    : [];
  assert.deepEqual(easWorkflowFiles, []);
});

test("desktop releases build macOS only", () => {
  const source = readFileSync(desktopReleaseWorkflowPath, "utf8");
  const trigger = source.split("jobs:", 1)[0];

  assert.deepEqual(
    [...jobBlocks(source).keys()],
    ["create-release", "publish-macos", "finalize-rollout"],
  );
  assert.match(trigger, /- "v\*"/);
  assert.match(trigger, /- "desktop-macos-v\*"/);
  assert.match(source, /!startsWith\(github\.ref_name, 'desktop-macos-v'\)/);
  assert.doesNotMatch(
    source,
    /desktop-v\*|desktop-linux|desktop-windows|publish-linux|publish-windows/,
  );
  assert.doesNotMatch(source, /github\.event\.inputs\.platform/);
  assert.match(source, /runner: macos-14\s+electron_arch: arm64/);
  assert.match(source, /runner: macos-15-intel\s+electron_arch: x64/);
  assert.match(source, /manifest_name="\$\{RELEASE_CHANNEL\}-mac\.yml"/);
  assert.match(source, /needs: \[publish-macos\]/);
});
