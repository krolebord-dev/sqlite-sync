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
  const cdpSession = options.profile ? await page.context().newCDPSession(page) : null;

  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(`[browser:${message.type()}] ${message.text()}`);
    }
  });

  await page.goto(`${options.baseUrl}/crdt-event-throughput/`, {
    waitUntil: "networkidle",
    timeout: options.timeoutMs,
  });

  await page.waitForFunction(
    () => typeof window.__sqliteSyncBenchmarks?.runCrdtEventThroughputBenchmark === "function",
    undefined,
    { timeout: options.timeoutMs },
  );

  let benchmarkResult;
  let cpuProfile;

  try {
    if (cdpSession) {
      await cdpSession.send("Profiler.enable");
      await cdpSession.send("Profiler.start");
    }

    benchmarkResult = await page.evaluate(
      async ({ eventCount, rounds }) => {
        return await window.__sqliteSyncBenchmarks.runCrdtEventThroughputBenchmark({
          eventCount,
          rounds,
        });
      },
      {
        eventCount: options.eventCount,
        rounds: options.rounds,
      },
    );
  } finally {
    if (cdpSession) {
      cpuProfile = (await cdpSession.send("Profiler.stop")).profile;
      await cdpSession.send("Profiler.disable");
    }
  }

  const result = {
    benchmark: "crdt-event-throughput",
    browser: {
      name: "chromium",
      version: browser.version(),
      headless: !options.headed,
    },
    options: {
      eventCount: options.eventCount,
      rounds: options.rounds,
      url: `${options.baseUrl}/crdt-event-throughput/`,
    },
    result: benchmarkResult,
  };

  const output = JSON.stringify(result, null, 2);
  printBenchmarkTable(result);

  if (cpuProfile && options.profileOutputFile) {
    await writeTextFile(options.profileOutputFile, `${JSON.stringify(cpuProfile, null, 2)}\n`);
    console.error(`Wrote CPU profile to ${options.profileOutputFile}`);
  }

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
    eventCount: 20_000,
    rounds: 5,
    port: 4173,
    headed: false,
    timeoutMs: 120_000,
    outputFile: "",
    profile: false,
    profileOutputFile: path.resolve(benchmarksDir, "artifacts", "crdt-event-throughput.cpuprofile"),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    switch (arg) {
      case "--event-count":
        options.eventCount = parseInteger(argv[++index], "event-count");
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
      case "--profile":
        options.profile = true;
        break;
      case "--profile-output":
        options.profile = true;
        options.profileOutputFile = argv[++index] ?? "";
        if (!options.profileOutputFile) {
          throw new Error("Missing value for --profile-output.");
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
  console.log(`Usage: pnpm --filter benchmarks benchmark:crdt-event-throughput [options]

Options:
  --event-count <n>  Number of events per workload. Default: 20000
  --rounds <n>       Number of timed rounds. Default: 5
  --port <n>         Vite dev server port. Default: 4173
  --timeout-ms <n>   Timeout for server startup and benchmark run. Default: 120000
  --headed           Run Chromium in headed mode
  --output <file>    Write JSON results to a file
  --profile          Capture a Chromium CPU profile
  --profile-output   CPU profile output path. Default: apps/benchmarks/artifacts/crdt-event-throughput.cpuprofile
  --help             Show this message
`);
}

function printBenchmarkTable(result) {
  console.log(`Benchmark: ${result.benchmark}`);
  console.log(
    `Browser: ${result.browser.name} ${result.browser.version} (${result.browser.headless ? "headless" : "headed"})`,
  );
  console.log(`Workload: ${result.options.eventCount} events, ${result.options.rounds} rounds`);
  console.log(`URL: ${result.options.url}`);
  console.log("");

  const rows = result.result.rows.map((row) => ({
    Task: row.name,
    "Events/Workload": row.eventsPerWorkload.toLocaleString(),
    "Throughput (events/sec)": row.throughputEventsPerSecond.toFixed(2),
    "Mean (ms)": row.meanMs.toFixed(3),
    "Min (ms)": row.minMs.toFixed(3),
    "Max (ms)": row.maxMs.toFixed(3),
    Rounds: String(row.rounds),
  }));

  console.log(formatTable(rows));
  console.log("");
  console.log(result.result.sanity.create);
  console.log(result.result.sanity.update);
  console.log(result.result.sanity.delete);
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
      const response = await fetch(baseUrl);
      if (response.ok) {
        return;
      }
    } catch {}

    await delay(500);
  }

  throw new Error(`Timed out waiting for Vite server at ${baseUrl}.`);
}

function stopServer(server) {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeTextFile(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFsFile(filePath, contents, "utf8");
}
