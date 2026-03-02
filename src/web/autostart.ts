import { spawn } from "node:child_process";
import type { AppConfig } from "../types/contracts.js";

type EnsureWebResult = {
  url: string;
  started: boolean;
};

function normalizeHostForDisplay(host: string): string {
  return host === "0.0.0.0" ? "localhost" : host;
}

async function isWebServerReachable(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${normalizeHostForDisplay(host)}:${port}/api/runs?limit=1`, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureWebObservatory(args: AppConfig["web"]): Promise<EnsureWebResult> {
  const host = args.host || "127.0.0.1";
  const port = args.port || 4789;
  const url = `http://${normalizeHostForDisplay(host)}:${port}`;

  if (await isWebServerReachable(host, port)) {
    return { url, started: false };
  }

  const cliEntry = process.argv[1];
  if (!cliEntry) {
    return { url, started: false };
  }

  const child = spawn(process.execPath, [cliEntry, "web", "--port", String(port), "--host", host], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await isWebServerReachable(host, port)) {
      return { url, started: true };
    }
    await delay(200);
  }

  return { url, started: false };
}
