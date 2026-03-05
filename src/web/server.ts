import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getRunDetails, listRuns } from "../storage/index.js";

function json(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function parseLimit(url: URL, fallback = 60): number {
  const raw = url.searchParams.get("limit");
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, 300);
}

function durationMs(startedAt?: string, finishedAt?: string): number | null {
  if (!startedAt || !finishedAt) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${remSeconds}s`;
}

function html(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DarlClawv Observatory</title>
  <style>
    :root {
      --bg0: #0b1118;
      --bg1: #0f1722;
      --bg2: #131d2b;
      --line: #243146;
      --fg: #e6eefb;
      --muted: #9db1cc;
      --ok: #34d399;
      --bad: #f87171;
      --warn: #f59e0b;
      --accent: #38bdf8;
      --violet: #818cf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--fg);
      background:
        radial-gradient(1200px 700px at 90% -10%, rgba(56,189,248,0.15), transparent 50%),
        radial-gradient(1200px 700px at -10% 110%, rgba(129,140,248,0.12), transparent 50%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      height: 100vh;
      overflow: hidden;
    }
    .layout {
      display: grid;
      grid-template-columns: 340px 1fr;
      height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: rgba(14, 22, 34, 0.88);
      backdrop-filter: blur(4px);
      overflow: auto;
    }
    .main {
      overflow: auto;
      padding: 18px;
    }
    .head {
      padding: 14px 14px 10px 14px;
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      background: rgba(14, 22, 34, 0.95);
      z-index: 5;
    }
    .title {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0.3px;
    }
    .sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .controls {
      margin-top: 10px;
      display: flex;
      gap: 8px;
    }
    .btn, .select {
      border: 1px solid var(--line);
      background: var(--bg2);
      color: var(--fg);
      border-radius: 10px;
      font-size: 12px;
      padding: 7px 10px;
      cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .runs { padding: 10px; }
    .run {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 8px;
      cursor: pointer;
      background: rgba(19, 29, 43, 0.65);
    }
    .run:hover { border-color: var(--accent); }
    .run.active { border-color: var(--violet); box-shadow: inset 0 0 0 1px rgba(129,140,248,0.35); }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .rid {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-size: 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      white-space: nowrap;
    }
    .ok { color: var(--ok); border-color: rgba(52,211,153,0.5); }
    .failed { color: var(--bad); border-color: rgba(248,113,113,0.5); }
    .running { color: var(--warn); border-color: rgba(245,158,11,0.5); }
    .small {
      color: var(--muted);
      font-size: 11px;
      margin-top: 6px;
      word-break: break-all;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .card {
      background: rgba(15, 23, 34, 0.72);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
    }
    .card h3 {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
    .kpi {
      margin-top: 8px;
      font-size: 24px;
      font-weight: 700;
      line-height: 1;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .panel {
      background: rgba(15, 23, 34, 0.72);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      min-height: 220px;
    }
    .panel h2 {
      margin: 0 0 10px 0;
      font-size: 14px;
      letter-spacing: 0.2px;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
    }
    .scroll {
      max-height: 360px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: rgba(8, 13, 22, 0.55);
    }
    .timeline-item {
      border-left: 2px solid var(--line);
      padding-left: 10px;
      margin-bottom: 8px;
    }
    .muted { color: var(--muted); }
    .danger { color: var(--bad); }
    .warn { color: var(--warn); }
    .ok-text { color: var(--ok); }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { height: 38vh; border-right: none; border-bottom: 1px solid var(--line); }
      .cards { grid-template-columns: repeat(2, minmax(160px, 1fr)); }
      .detail-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="head">
        <h1 class="title">DarlClawv Observatory</h1>
        <div class="sub">Run timeline, memory and guard violations</div>
        <div class="controls">
          <button class="btn" id="refreshBtn">Refresh</button>
          <button class="btn" id="autoBtn">Auto: On</button>
          <select class="select" id="limitSel">
            <option value="30">30 runs</option>
            <option value="60" selected>60 runs</option>
            <option value="120">120 runs</option>
          </select>
        </div>
      </div>
      <div class="runs" id="runs"></div>
    </aside>
    <main class="main">
      <div class="cards">
        <div class="card"><h3>Status</h3><div id="kStatus" class="kpi">-</div></div>
        <div class="card"><h3>Duration</h3><div id="kDuration" class="kpi">-</div></div>
        <div class="card"><h3>Guard Errors</h3><div id="kGuard" class="kpi">-</div></div>
      </div>
      <div class="detail-grid">
        <section class="panel">
          <h2>Run Context</h2>
          <div class="scroll mono" id="contextBox">Select a run.</div>
        </section>
        <section class="panel">
          <h2>Phases & Timeline</h2>
          <div class="scroll mono" id="timelineBox">-</div>
        </section>
        <section class="panel">
          <h2>Tools & Memory</h2>
          <div class="scroll mono" id="toolMemoryBox">-</div>
        </section>
        <section class="panel" style="grid-column: 1 / -1;">
          <h2>Raw Events</h2>
          <div class="scroll mono" id="eventsBox">-</div>
        </section>
      </div>
    </main>
  </div>
  <script>
    let selectedRunId = null;
    let autoRefresh = true;
    let timer = null;

    const el = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }

    function statusClass(status) {
      if (status === "ok") return "ok";
      if (status === "failed") return "failed";
      return "running";
    }

    function humanMs(ms) {
      if (ms == null) return "-";
      if (ms < 1000) return ms + "ms";
      const sec = Math.floor(ms / 1000);
      const min = Math.floor(sec / 60);
      const rem = sec % 60;
      if (min === 0) return sec + "s";
      return min + "m " + rem + "s";
    }

    function guardViolations(events) {
      return (events || []).filter((e) =>
        e.type === "run.error" &&
        (String(e.message || "").includes("forbidden roots") ||
         String(e.message || "").includes("outside allowed roots"))
      );
    }

    function buildTimeline(events) {
      const rows = [];
      for (const e of events || []) {
        if (e.type === "workflow.phase.changed" || e.type === "thread.created" || e.type === "thread.resumed") {
          rows.push(
            '<div class="timeline-item">' +
              '<div><b>' + esc(e.type) + '</b></div>' +
              '<div class="muted">' + esc(e.ts || "-") + '</div>' +
              '<div>' + esc(JSON.stringify(e)) + '</div>' +
            '</div>'
          );
        }
      }
      if (rows.length === 0) return "<div class='muted'>No timeline events.</div>";
      return rows.join("");
    }

    async function loadRuns() {
      const limit = el("limitSel").value;
      const runs = await api("/api/runs?limit=" + encodeURIComponent(limit));
      const box = el("runs");
      box.innerHTML = "";
      for (const run of runs) {
        const div = document.createElement("div");
        div.className = "run" + (run.runId === selectedRunId ? " active" : "");
        div.innerHTML =
          '<div class="row">' +
            '<div class="rid">' + esc(run.runId) + '</div>' +
            '<div class="badge ' + statusClass(run.status) + '">' + esc(run.status) + '</div>' +
          '</div>' +
          '<div class="small">' + esc(run.startedAt || "-") + '</div>' +
          '<div class="small">duration: ' + esc(run.duration || "-") + '</div>';
        div.onclick = async () => {
          selectedRunId = run.runId;
          await loadRuns();
          await loadRun(run.runId);
        };
        box.appendChild(div);
      }
      if (!selectedRunId && runs.length > 0) {
        selectedRunId = runs[0].runId;
        await loadRuns();
        await loadRun(selectedRunId);
      }
    }

    async function loadRun(runId) {
      const data = await api("/api/runs/" + encodeURIComponent(runId));
      const events = data.events || [];
      const guard = guardViolations(events);

      const duration = data.summary.finishedAt
        ? (new Date(data.summary.finishedAt).getTime() - new Date(data.summary.startedAt).getTime())
        : null;

      el("kStatus").innerHTML = '<span class="' + statusClass(data.summary.status) + '">' + esc(data.summary.status) + '</span>';
      el("kDuration").textContent = humanMs(duration);
      el("kGuard").innerHTML = guard.length > 0
        ? '<span class="danger">' + guard.length + "</span>"
        : '<span class="ok-text">0</span>';

      const req = data.summary.request || {};
      const usage = data.result && data.result.usage ? data.result.usage : null;
      el("contextBox").innerHTML =
        '<div><b>runId:</b> ' + esc(data.summary.runId) + '</div>' +
        '<div><b>agentId:</b> ' + esc(req.agentId || "-") + '</div>' +
        '<div><b>taskWorkspace:</b> ' + esc(req.taskWorkspace || "-") + '</div>' +
        '<div><b>controlPlaneRoot:</b> ' + esc(req.controlPlaneRoot || "-") + '</div>' +
        '<div><b>status:</b> ' + esc(data.summary.status) + '</div>' +
        '<div><b>failureKind:</b> ' + esc(data.summary.failureKind || "-") + '</div>' +
        '<div><b>usage:</b> ' + esc(JSON.stringify(usage)) + '</div>' +
        '<hr style="border:0;border-top:1px solid #243146;margin:8px 0;" />' +
        '<div><b>task:</b></div><div>' + esc(req.task || "-") + '</div>';

      el("timelineBox").innerHTML = buildTimeline(events);

      const toolRows = [];
      for (const e of events) {
        if (e.type === "tool.called" || e.type === "tool.result" || e.type.startsWith("memory.")) {
          toolRows.push('<div class="small">' + esc(JSON.stringify(e)) + "</div>");
        }
      }
      if (guard.length > 0) {
        toolRows.push("<hr style='border:0;border-top:1px solid #243146;margin:8px 0;' />");
        toolRows.push("<div class='danger'><b>Guard Violations</b></div>");
        for (const g of guard) {
          toolRows.push('<div class="small danger">' + esc(JSON.stringify(g)) + "</div>");
        }
      }
      el("toolMemoryBox").innerHTML = toolRows.length > 0 ? toolRows.join("") : "<div class='muted'>No tool/memory events.</div>";

      el("eventsBox").innerHTML = events.map((e) => esc(JSON.stringify(e))).join("<br/>") || "<span class='muted'>No events.</span>";
    }

    async function refreshAll() {
      try {
        await loadRuns();
        if (selectedRunId) {
          await loadRun(selectedRunId);
        }
      } catch (err) {
        console.error(err);
      }
    }

    function startTimer() {
      stopTimer();
      timer = setInterval(() => {
        if (autoRefresh) refreshAll();
      }, 5000);
    }

    function stopTimer() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    el("refreshBtn").onclick = refreshAll;
    el("autoBtn").onclick = () => {
      autoRefresh = !autoRefresh;
      el("autoBtn").textContent = "Auto: " + (autoRefresh ? "On" : "Off");
    };
    el("limitSel").onchange = refreshAll;

    refreshAll();
    startTimer();
  </script>
</body>
</html>`;
}

async function handleApi(url: URL, res: ServerResponse): Promise<boolean> {
  if (url.pathname === "/api/runs") {
    const limit = parseLimit(url, 60);
    const runs = await listRuns();
    const payload = runs.slice(0, limit).map((run) => ({
      ...run,
      duration: formatDuration(durationMs(run.startedAt, run.finishedAt))
    }));
    json(res, 200, payload);
    return true;
  }

  if (url.pathname.startsWith("/api/runs/")) {
    const runId = decodeURIComponent(url.pathname.split("/").pop() || "");
    const run = await getRunDetails(runId);
    if (!run) {
      json(res, 404, { error: "not_found" });
      return true;
    }
    json(res, 200, run);
    return true;
  }

  return false;
}

function createViewerServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (await handleApi(url, res)) {
      return;
    }

    if (url.pathname === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html());
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });
}

export async function startWebServer(port: number, host = "127.0.0.1"): Promise<number> {
  const maxAttempts = 20;

  for (let i = 0; i < maxAttempts; i += 1) {
    const tryPort = port + i;
    const server = createViewerServer();
    const bound = await new Promise<number | null>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          server.removeAllListeners("listening");
          resolve(null);
          return;
        }
        throw error;
      };

      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        const info = server.address() as AddressInfo;
        resolve(info.port);
      });
      server.listen(tryPort, host);
    });

    if (bound) {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      console.log(`DarlClawv observatory: http://${displayHost}:${bound}`);
      return bound;
    }
  }

  throw new Error(`Unable to start web server after ${maxAttempts} ports from ${port}.`);
}
