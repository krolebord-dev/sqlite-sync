#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile as writeFsFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const benchmarksDir = path.resolve(scriptDir, "..");

const options = parseArgs(process.argv.slice(2));
const server = startViteServer({ cwd: benchmarksDir, port: options.port });

let browser;

try {
  await waitForServer(server, options.baseUrl, options.timeoutMs);

  browser = await chromium.launch({ headless: !options.headed });
  const page = await browser.newPage();

  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(`[browser:${message.type()}] ${message.text()}`);
    }
  });

  await page.goto(`${options.baseUrl}/sqlite-kv-store-rowid/`, {
    waitUntil: "networkidle",
    timeout: options.timeoutMs,
  });

  await page.waitForFunction(
    () => typeof window.__sqliteSyncBenchmarks?.runSqliteKvStoreRowIdBenchmark === "function",
    undefined,
    { timeout: options.timeoutMs },
  );

  const benchmarkResult = await page.evaluate(
    async ({ keyCount, iterations, rounds }) => {
      return await window.__sqliteSyncBenchmarks.runSqliteKvStoreRowIdBenchmark({
        keyCount,
        iterations,
        rounds,
      });
    },
    {
      keyCount: options.keyCount,
      iterations: options.iterations,
      rounds: options.rounds,
    },
  );

  const result = {
    benchmark: "sqlite-kv-store-rowid",
    browser: {
      name: "chromium",
      version: browser.version(),
      headless: !options.headed,
    },
    options: {
      keyCount: options.keyCount,
      iterations: options.iterations,
      rounds: options.rounds,
      url: `${options.baseUrl}/sqlite-kv-store-rowid/`,
    },
    result: benchmarkResult,
  };

  const output = JSON.stringify(result, null, 2);
  printBenchmarkTable(result);

  if (options.outputFile) {
    await writeTextFile(options.outputFile, `${output}\n`);
    console.error(`Wrote benchmark results to ${options.outputFile}`);
  }
} finally {
  if (browser) {
    await browser.close();
  }

  stopServer(server);
}

function parseArgs(argv) {
  const options = {
    keyCount: 1_000,
    iterations: 50_000,
    rounds: 5,
    port: 4173,
    headed: false,
    timeoutMs: 120_000,
    outputFile: "",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    switch (arg) {
      case "--key-count":
        options.keyCount = parseInteger(argv[++index], "key-count");
        break;
      case "--iterations":
        options.iterations = parseInteger(argv[++index], "iterations");
        break;
      case "--rounds":
        options.rounds = parseInteger(argv[++index], "rounds");
        break;
      case "--port":
        options.port = parseInteger(argv[++index], "port");
        break;
      case "--timeout-ms":
        options.timeoutMs = parseInteger(argv[++index], "timeout-ms");
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--output":
        options.outputFile = argv[++index] ?? "";
        if (!options.outputFile) {
          throw new Error("Missing value for --output.");
        }
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    ...options,
    baseUrl: `http://127.0.0.1:${options.port}`,
  };
}

function parseInteger(value, name) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected --${name} to be a positive integer.`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node ./scripts/run-sqlite-kv-store-rowid.mjs [options]

Options:
  --key-count <n>    Number of seeded keys. Default: 1000
  --iterations <n>   Operations per workload. Default: 50000
  --rounds <n>       Number of timed rounds. Default: 5
  --port <n>         Vite dev server port. Default: 4173
  --timeout-ms <n>   Timeout for server startup and benchmark run. Default: 120000
  --headed           Run Chromium in headed mode
  --output <file>    Write JSON results to a file
  --help             Show this message
`);
}

function printBenchmarkTable(result) {
  console.log(`Benchmark: ${result.benchmark}`);
  console.log(
    `Browser: ${result.browser.name} ${result.browser.version} (${result.browser.headless ? "headless" : "headed"})`,
  );
  console.log(
    `Workload: ${result.options.keyCount.toLocaleString()} seeded keys, ${result.options.iterations.toLocaleString()} ops/workload, ${result.options.rounds} rounds`,
  );
  console.log(`URL: ${result.options.url}`);
  console.log("");

  const rows = result.result.rows.map((row) => ({
    Workload: row.workload,
    "Rowid Mean (ms)": row.rowid.meanMs.toFixed(3),
    "Without Rowid Mean (ms)": row.withoutRowid.meanMs.toFixed(3),
    "Rowid Ops/sec": row.rowid.throughputOpsPerSecond.toFixed(2),
    "Without Rowid Ops/sec": row.withoutRowid.throughputOpsPerSecond.toFixed(2),
    Faster: row.fasterVariant,
    "Delta (%)": row.deltaPercent.toFixed(2),
  }));

  console.log(formatTable(rows));
  console.log("");

  for (const line of result.result.sanity) {
    console.log(line);
  }
}

function formatTable(rows) {
  if (rows.length === 0) {
    return "(no rows)";
  }

  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header]).length)));
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const formatRow = (row) => headers.map((header, index) => String(row[header]).padEnd(widths[index])).join(" | ");

  return [
    formatRow(Object.fromEntries(headers.map((header) => [header, header]))),
    divider,
    ...rows.map(formatRow),
  ].join("\n");
}

function startViteServer({ cwd, port }) {
  const child = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  return child;
}

async function waitForServer(server, baseUrl, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Vite server exited early with code ${server.exitCode}.`);
    }

    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for Vite server at ${baseUrl}.`);
}

function stopServer(server) {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
  }
}

async function writeTextFile(filePath, contents) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFsFile(absolutePath, contents, "utf8");
}
