#!/usr/bin/env node
// Install one fork preview tarball into an empty prefix and check that the
// installed CLI and MCP server are the ones answering. Imports nothing from the
// checkout: every check runs the installed package with an isolated home.
// Usage: node scripts/ci/fork-install-smoke.mjs <package.tgz> <expected-version>
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const [tarballArgument, expectedVersion, ...extra] = process.argv.slice(2);
if (
  tarballArgument === undefined ||
  expectedVersion === undefined ||
  extra.length
)
  throw new Error(
    "Usage: node scripts/ci/fork-install-smoke.mjs <package.tgz> <expected-version>",
  );
const tarball = resolve(tarballArgument);
const windows = process.platform === "win32";
const workspace = await realpath(
  await mkdtemp(join(tmpdir(), "rea-fork-install-")),
);
const prefix = join(workspace, "prefix");
const home = join(workspace, "home");
await mkdir(home, { recursive: true });

// Only what a launcher needs; no ambient REA_* settings or client configs.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL)$/iu.test(
      key,
    ),
  ),
);
Object.assign(environment, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  npm_config_cache: join(workspace, "npm-cache"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
});

const checks = [];
const check = (name, passed, detail = {}) => {
  checks.push({ ...detail, name, passed });
  if (!passed) process.exitCode = 1;
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    env: environment,
    cwd: workspace,
    encoding: "utf8",
    shell: windows && command === "npm",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

try {
  // 1. Install exactly this tarball into an empty global prefix.
  const install = run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    tarball,
  ]);
  check("npm install of the tarball", install.status === 0, {
    exit_code: install.status,
    ...(install.status === 0 ? {} : { stderr: install.stderr.slice(-2000) }),
  });
  if (install.status !== 0) throw new Error("installation failed");

  const packageRoot = windows
    ? join(prefix, "node_modules", "rea-agents")
    : join(prefix, "lib", "node_modules", "rea-agents");
  const entry = join(packageRoot, "scripts", "rea.mjs");
  const installed = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  check(
    "installed package identity",
    installed.name === "rea-agents" && installed.version === expectedVersion,
    { package_name: installed.name, version: installed.version },
  );
  check(
    "installed package points to the fork",
    installed.bugs?.url === "https://github.com/serrrdarrrkesikbas/rea/issues",
    { bugs: installed.bugs?.url ?? null },
  );
  const cli = (args) => run(process.execPath, [entry, ...args]);

  // 2. CLI identity and the operation view.
  const version = cli(["--version"]);
  check("rea --version", version.stdout.trim() === expectedVersion, {
    exit_code: version.status,
    output: version.stdout.trim(),
  });
  const operation = cli([
    "capabilities",
    "--operation",
    "search_bytes",
    "--json",
  ]);
  const operationView = json(operation.stdout);
  check(
    "CLI capabilities --operation search_bytes",
    operation.status === 0 &&
      operationView?.operation === "search_bytes" &&
      Array.isArray(operationView?.operation_candidates) &&
      operationView.operation_candidates.length > 0,
    {
      exit_code: operation.status,
      candidates: operationView?.operation_candidates?.map(
        (candidate) =>
          `${candidate.provider.id}:${candidate.availability.status}/${candidate.declaration.status}`,
      ),
    },
  );
  const unknown = cli([
    "capabilities",
    "--operation",
    "no_such_tool",
    "--json",
  ]);
  const unknownView = json(unknown.stdout);
  check(
    "CLI rejects an unknown operation",
    unknown.status !== 0 && unknownView?.error?.category === "invalid_input",
    { exit_code: unknown.status, category: unknownView?.error?.category },
  );

  // 3. rea update must not replace the fork with npm's upstream release.
  const update = cli(["update", "--json"]);
  check(
    "rea update refuses to replace the fork preview",
    update.status !== 0 &&
      `${update.stdout}${update.stderr}`.includes(
        "https://github.com/serrrdarrrkesikbas/rea/releases",
      ),
    { exit_code: update.status },
  );

  // 4. Setup registers this installed entry point, not a package runner.
  const setup = cli([
    "setup",
    "--client",
    "codex",
    "--skill=false",
    "--dry-run",
    "--json",
  ]);
  // The plan shows each registration command as JSON-quoted arguments inside
  // the action detail, so compare against the quoted entry path.
  const registrations = (json(setup.stdout)?.plannedActions ?? []).filter(
    (action) => action.kind === "configure_client",
  );
  check(
    "setup --dry-run registers the installed entry point",
    setup.status === 0 &&
      registrations.length > 0 &&
      registrations.every(
        ({ detail }) =>
          typeof detail === "string" &&
          detail.includes(`${JSON.stringify(entry)} "mcp"`) &&
          !/\bnpx\b|rea-agents@/u.test(detail),
      ),
    { exit_code: setup.status, registrations: registrations.length },
  );

  // 5. MCP over stdio from the installed package.
  const mcp = await mcpSession(entry, async (call) => {
    const summary = await call("binary_session", {});
    const complete = await call("binary_session", { detail: "complete" });
    const view = await call("binary_session", {
      detail: "operation",
      operation: "search_bytes",
    });
    const missing = await call("binary_session", { detail: "operation" });
    const unknownTool = await call("binary_session", {
      detail: "operation",
      operation: "no_such_tool",
    });
    return { summary, complete, view, missing, unknownTool };
  });
  const result = (response) => response?.structuredContent?.result;
  const identity = result(mcp.summary)?.server_identity?.package;
  check(
    "MCP server runs from the installed package",
    identity?.version === expectedVersion &&
      typeof identity?.root_path === "string" &&
      (await realpath(identity.root_path)) === (await realpath(packageRoot)),
    {
      version: identity?.version ?? null,
      root_path_matches: identity?.root_path !== undefined,
    },
  );
  check(
    "MCP summary detail",
    result(mcp.summary)?.detail === "summary" &&
      Array.isArray(result(mcp.summary)?.omitted_fields),
  );
  check(
    "MCP complete detail",
    result(mcp.complete)?.detail === "complete" &&
      result(mcp.complete)?.omitted_fields === undefined &&
      Array.isArray(result(mcp.complete)?.analysis_provider_candidates),
  );
  check(
    "MCP operation detail",
    result(mcp.view)?.detail === "operation" &&
      result(mcp.view)?.operation === "search_bytes" &&
      Array.isArray(result(mcp.view)?.operation_candidates) &&
      result(mcp.view)?.analysis_provider_candidates === undefined,
    {
      structured_bytes: Buffer.byteLength(
        JSON.stringify(mcp.view?.structuredContent ?? null),
      ),
      complete_bytes: Buffer.byteLength(
        JSON.stringify(mcp.complete?.structuredContent ?? null),
      ),
    },
  );
  for (const [name, response] of [
    ["MCP rejects detail operation without operation", mcp.missing],
    ["MCP rejects an unknown operation", mcp.unknownTool],
  ])
    check(name, response?.isError === true);
  const cliCandidates = JSON.stringify(operationView?.operation_candidates);
  check(
    "CLI and MCP report the same candidates",
    cliCandidates === JSON.stringify(result(mcp.view)?.operation_candidates),
  );
} catch (cause) {
  check("smoke run completed", false, {
    error: String(cause?.message ?? cause),
  });
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(
    () => undefined,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      tarball: tarball.split(sep).at(-1),
      expected_version: expectedVersion,
      passed: checks.every(({ passed }) => passed),
      checks,
    },
    null,
    2,
  )}\n`,
);

/** Minimal newline-delimited JSON-RPC client for one stdio MCP session. */
async function mcpSession(entry, body) {
  const child = spawn(process.execPath, [entry, "mcp"], {
    env: environment,
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      const message = json(line);
      if (message?.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.resume();
  const request = (method, params) =>
    new Promise((resolveRequest, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        120_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolveRequest(message.result);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rea-fork-install-smoke", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return await body((name, args) =>
      request("tools/call", { name, arguments: args }),
    );
  } finally {
    child.stdin.end();
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill();
        resolveExit();
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}
