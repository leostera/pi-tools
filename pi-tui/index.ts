import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";
import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";
const { Terminal } = xtermHeadless as any;
const { SerializeAddon } = xtermSerialize as any;
import * as pty from "node-pty";
import * as http from "node:http";
import { parse as parseShell } from "shell-quote";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:7777";
const DEFAULT_PORT = 7777;
const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 40;
const LOOP_DELAY_MS = 1_000;
const WATCHDOG_MS = 10_000;
const STUCK_TURN_MS = 5 * 60_000;
const TURNS_DIR = path.resolve(process.cwd(), "turns");
const CONTEXT_FILE = path.resolve(process.cwd(), "context.md");

type GameAction =
  | { type: "press_key"; key: string }
  | { type: "press_sequence"; keys: string[] }
  | { type: "wait"; seconds: number }
  | { type: "narrate"; message: string }
  | { type: "noop" };

type Turn = { turn: number; goal?: string; narration?: string; action: GameAction; summary: string; screen: string; screen_html: string };
type Chat = { id: number; user: string; text: string };

let piApi: ExtensionAPI | null = null;
let session: TuiSession | null = null;
let serverUrl = DEFAULT_URL;
let runningLoop = false;
let turnInFlight = false;
let pendingPrompt = false;
let turnStartedAt = 0;
let maxTurns: number | undefined;
let watchdog: ReturnType<typeof setInterval> | null = null;
let recentSummaries: string[] = [];
let contextEpoch = 0;

class TuiSession {
  command: string;
  args: string[];
  port: number;
  cols: number;
  rows: number;
  cwd: string;
  term: Terminal;
  serializer: SerializeAddon;
  proc: pty.IPty;
  server: http.Server;
  turns: Turn[] = [];
  chat: Chat[] = [];
  message = "TUI driver online";
  lastNarration = "";

  constructor(command: string, args: string[], port: number, cols: number, rows: number, cwd = process.cwd()) {
    this.command = command;
    this.args = args;
    this.port = port;
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.proc = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    this.proc.onData((data) => this.term.write(data));
    this.proc.onExit(() => {
      this.message = "process exited";
      runningLoop = false;
    });
    this.server = this.createServer();
  }

  createServer(): http.Server {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        if (req.method === "GET" && url.pathname === "/") return send(res, 200, INDEX_HTML, "text/html; charset=utf-8");
        if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, this.fullState());
        if (req.method === "GET" && url.pathname === "/api/agent_state") return sendJson(res, this.agentState());
        if (req.method === "POST" && (url.pathname === "/api/command" || url.pathname === "/api/agent_command")) {
          const body = await readJson(req);
          await this.apply(body.action, body.goal, body.narration);
          return sendJson(res, url.pathname.includes("agent") ? this.agentState() : this.fullState());
        }
        if (req.method === "POST" && url.pathname === "/api/message") {
          const body = await readJson(req);
          this.message = String(body.message ?? "");
          return sendJson(res, this.fullState());
        }
        send(res, 404, "not found", "text/plain");
      } catch (error) {
        send(res, 500, error instanceof Error ? error.message : String(error), "text/plain");
      }
    });
    server.listen(this.port, "127.0.0.1");
    return server;
  }

  screen(): string {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n").replace(/\s+$/g, "");
  }

  screenHtml(): string {
    try {
      return this.serializer.serializeAsHTML({ scrollback: 0, includeGlobalBackground: true });
    } catch {
      return escapeHtml(this.screen());
    }
  }

  fullState() {
    return { screen: this.screen(), screen_html: this.screenHtml(), message: this.message, turn_count: this.turnCount(), actions: this.turns, chat: this.chat };
  }

  agentState() {
    return { screen: this.screen(), message: this.message, turn_count: this.turnCount(), chat: this.chat.slice(-8) };
  }

  turnCount() { return this.turns.at(-1)?.turn ?? 0; }

  applyEffect(action: GameAction, goal?: string, narration?: string) {
    return Effect.gen(this, function* () {
      if (!action) action = { type: "noop" };
      if (action.type === "press_key") this.proc.write(bytesForKey(action.key));
      if (action.type === "press_sequence") {
        for (const key of action.keys.slice(0, 16)) {
          this.proc.write(bytesForKey(key));
          yield* sleepEffect(80);
        }
      }
      if (action.type === "wait") yield* sleepEffect(Math.max(0, Math.min(30, action.seconds)) * 1000);
      if (action.type === "narrate") { this.lastNarration = action.message; narration ||= action.message; }
      yield* sleepEffect(120);
      const turn = this.turnCount() + 1;
      const summary = actionSummary(action);
      const record = { turn, goal, narration, action, summary, screen: this.screen(), screen_html: this.screenHtml() };
      this.turns.push(record);
      if (this.turns.length > 250) this.turns.shift();
      this.message = `Turn ${turn}: ${summary}`;
      yield* writeTurnFileEffect(record, this.agentState());
    });
  }

  async apply(action: GameAction, goal?: string, narration?: string) {
    return run(this.applyEffect(action, goal, narration));
  }

  dispose() {
    try { this.server.close(); } catch {}
    try { this.proc.kill(); } catch {}
  }
}

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);

const tryPromise = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => cause });

const sleepEffect = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const requestEffect = (pathname: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const res = yield* tryPromise(() => fetch(`${serverUrl}${pathname}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    }));
    if (!res.ok) {
      const body = yield* tryPromise(() => res.text());
      return yield* Effect.fail(new Error(`${res.status} ${res.statusText}: ${body}`));
    }
    return yield* tryPromise(() => res.json());
  });

const stateEffect = () => requestEffect("/api/agent_state");
const commandEffect = (action: GameAction, goal?: string, narration?: string) =>
  requestEffect("/api/agent_command", { method: "POST", body: JSON.stringify({ action, goal, narration }) });
const state = () => run(stateEffect());
const command = (action: GameAction, goal?: string, narration?: string) => run(commandEffect(action, goal, narration));

function scheduleTurn() {
  if (!piApi || !runningLoop || turnInFlight || pendingPrompt) return;
  if (maxTurns !== undefined && (session?.turnCount() ?? 0) >= maxTurns) { runningLoop = false; return; }
  pendingPrompt = true;
  setTimeout(async () => {
    if (!piApi || !runningLoop || turnInFlight) return;
    pendingPrompt = false;
    let s: any;
    try { s = await state(); } catch { scheduleTurn(); return; }
    turnInFlight = true;
    turnStartedAt = Date.now();
    const completed = s.turn_count ?? 0;
    const next = completed + 1;
    const context = await readContext();
    const rest = next > 0 && next % 20 === 0;
    const prompt = `TUI Driver turn ${next} (server has ${completed} completed turns).\n\nDrive the running TUI application autonomously. Never ask the human for input. Use tui_observe, then call exactly one TUI action tool. Keep inner dialogue minimal. Prefer adventurous/story-rich choices when appropriate. Save often when the app/game offers a safe save option.${rest ? "\n\nPacing: if safe, prefer tui_wait for about 30 seconds this turn." : ""}${context ? `\n\nLong-term context from ./context.md:\n${context}` : ""}`;
    try { piApi.sendUserMessage(prompt, { deliverAs: "followUp" }); } catch { piApi.sendUserMessage(prompt); }
  }, LOOP_DELAY_MS);
}

function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!runningLoop) return;
    const now = Date.now();
    if (turnInFlight && now - turnStartedAt > STUCK_TURN_MS) { turnInFlight = false; pendingPrompt = false; }
    scheduleTurn();
  }, WATCHDOG_MS);
}

export default function(pi: ExtensionAPI) {
  piApi = pi;
  void fs.mkdir(TURNS_DIR, { recursive: true });
  startWatchdog();

  pi.registerCommand("tui-run", {
    description: "Run/drive a TUI app. Usage: /tui-run [--port 7777] [--cols 140] [--rows 40] <command>",
    handler: async (args, ctx) => runTuiCommand(args || "", ctx),
  });

  pi.registerCommand("tui-stop", {
    description: "Stop the running TUI app/server.",
    handler: async (_args, ctx) => {
      stopTui();
      ctx.ui.notify("TUI driver stopped", "info");
    },
  });

  pi.registerCommand("tui-status", {
    description: "Show TUI driver status.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(await run(statusLineEffect()), "info");
    },
  });

  pi.on("agent_end", async () => { turnInFlight = false; pendingPrompt = false; scheduleTurn(); });
  // Do not dispose on generic session shutdown/reload events; only `/tui stop`
  // should intentionally kill the TUI process/server. This keeps status/cancel
  // style interactions from accidentally tearing down the running app.
  pi.on("session_shutdown", async () => { runningLoop = false; });

  registerTools(pi);
}

async function runTuiCommand(args: string, ctx: any) {
  const argv = parseArgs(args);
  let port = DEFAULT_PORT, cols = DEFAULT_COLS, rows = DEFAULT_ROWS;
  const cmd: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--cols") cols = Number(argv[++i]);
    else if (argv[i] === "--rows") rows = Number(argv[++i]);
    else cmd.push(argv[i]);
  }
  if (!cmd.length) { ctx.ui.notify("Missing command, e.g. /tui-run nethack", "error"); return; }
  session?.dispose();
  try {
    session = new TuiSession(cmd[0], cmd.slice(1), port, cols, rows);
  } catch (error) {
    session = null;
    runningLoop = false;
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to start TUI app: ${message}. If this says posix_spawnp failed, run from the repo root: npm rebuild node-pty --build-from-source`, "error");
    return;
  }
  serverUrl = `http://127.0.0.1:${port}`;
  runningLoop = true; turnInFlight = false; pendingPrompt = false; maxTurns = undefined;
  ctx.ui.notify(`TUI app running at ${serverUrl}`, "info");
  scheduleTurn();
}

function stopTui() {
  runningLoop = false;
  turnInFlight = false;
  pendingPrompt = false;
  session?.dispose();
  session = null;
}

function registerTools(pi: ExtensionAPI) {
  pi.registerTool({ name: "tui_observe", label: "TUI Observe", description: "Fetch the latest frame from the running TUI app.", parameters: Type.Object({}), async execute() { const s = await state(); return { content: [{ type: "text", text: s.screen }], details: compact(s) }; } });
  pi.registerTool({ name: "tui_press_key", label: "TUI Press Key", description: "Send one key. Examples: Enter, Escape, ArrowDown, Down, Numpad2, KP2, or a literal character.", parameters: Type.Object({ key: Type.String(), goal: Type.Optional(Type.String()), narration: Type.Optional(Type.String()) }), async execute(_id, p) { const s = await command({ type: "press_key", key: p.key }, p.goal, p.narration); return { content: [{ type: "text", text: s.screen }], details: compact(s) }; } });
  pi.registerTool({ name: "tui_press_sequence", label: "TUI Press Sequence", description: "Send a short sequence of keys.", parameters: Type.Object({ keys: Type.Array(Type.String(), { maxItems: 16 }), goal: Type.Optional(Type.String()), narration: Type.Optional(Type.String()) }), async execute(_id, p) { const s = await command({ type: "press_sequence", keys: p.keys }, p.goal, p.narration); return { content: [{ type: "text", text: s.screen }], details: compact(s) }; } });
  pi.registerTool({ name: "tui_wait", label: "TUI Wait", description: "Wait briefly and return the latest frame.", parameters: Type.Object({ seconds: Type.Number({ minimum: 0, maximum: 30 }), goal: Type.Optional(Type.String()), narration: Type.Optional(Type.String()) }), async execute(_id, p) { const s = await command({ type: "wait", seconds: p.seconds }, p.goal, p.narration); return { content: [{ type: "text", text: s.screen }], details: compact(s) }; } });
  pi.registerTool({ name: "tui_narrate", label: "TUI Narrate", description: "Add narration to the overlay without pressing keys.", parameters: Type.Object({ message: Type.String(), goal: Type.Optional(Type.String()) }), async execute(_id, p) { const s = await command({ type: "narrate", message: p.message }, p.goal, p.message); return { content: [{ type: "text", text: p.message }], details: compact(s) }; } });
  pi.registerTool({ name: "tui_noop", label: "TUI Noop", description: "Do nothing and return the latest frame.", parameters: Type.Object({ goal: Type.Optional(Type.String()), narration: Type.Optional(Type.String()) }), async execute(_id, p) { const s = await command({ type: "noop" }, p.goal, p.narration); return { content: [{ type: "text", text: s.screen }], details: compact(s) }; } });
}

function compact(s: any) { return { screen: s.screen ?? "", message: s.message ?? "", turn_count: s.turn_count ?? 0, chat: s.chat ?? [] }; }
function statusLine() { return `TUI driver: ${session ? "running" : "stopped"} ${serverUrl}`; }
function statusLineEffect() {
  return Effect.gen(function* () {
    if (!session) return statusLine();
    const s = yield* requestEffect("/api/agent_state").pipe(
      Effect.map((state: any) => `turn=${state.turn_count ?? 0} message=${state.message ?? ""}`),
      Effect.catchAll((error) => Effect.succeed(`server check failed=${String(error)}`)),
    );
    return `${statusLine()} ${s}`;
  });
}
function parseArgs(s: string) { return parseShell(s).filter((x): x is string => typeof x === "string"); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function send(res: http.ServerResponse, code: number, body: string, type: string) { res.writeHead(code, { "content-type": type }); res.end(body); }
function sendJson(res: http.ServerResponse, body: any) { send(res, 200, JSON.stringify(body), "application/json"); }
async function readJson(req: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c)); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
function escapeHtml(s: string) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]!)); }
function actionSummary(a: GameAction) { if (a.type === "press_key") return `Pressed ${a.key}`; if (a.type === "press_sequence") return `Pressed ${a.keys.length} keys`; if (a.type === "wait") return `Waited ${a.seconds}s`; if (a.type === "narrate") return `Narrated: ${a.message}`; return "Observed / no action"; }
function bytesForKey(key: string): string { const m: Record<string,string> = { Enter:"\r", Return:"\r", Escape:"\x1b", Esc:"\x1b", Tab:"\t", Backspace:"\x7f", Space:" ", Up:"\x1b[A", ArrowUp:"\x1b[A", UpArrow:"\x1b[A", Down:"\x1b[B", ArrowDown:"\x1b[B", DownArrow:"\x1b[B", Right:"\x1b[C", ArrowRight:"\x1b[C", RightArrow:"\x1b[C", Left:"\x1b[D", ArrowLeft:"\x1b[D", LeftArrow:"\x1b[D" }; if (m[key]) return m[key]; const kp = key.match(/^(?:Numpad|KP)([0-9])$/); if (kp) return kp[1]; if (key === "NumpadEnter" || key === "KPEnter") return "\r"; if ([...key].length === 1) return key; throw new Error(`unknown key mapping: ${key}`); }
const readContextEffect = () => tryPromise(async () => {
  try { return (await fs.readFile(CONTEXT_FILE, "utf8")).slice(-6000); } catch { return ""; }
});
async function readContext() { return run(readContextEffect()); }

const writeTurnFileEffect = (turn: Turn, _s: any) => tryPromise(async () => {
  await fs.mkdir(TURNS_DIR, { recursive: true });
  await fs.writeFile(path.join(TURNS_DIR, `${turn.turn}.md`), `# TUI Turn ${turn.turn}\n\n- Action: ${turn.summary}\n- Goal: ${turn.goal ?? ""}\n- Narration: ${turn.narration ?? ""}\n\n\`\`\`text\n${turn.screen}\n\`\`\`\n`, "utf8");
  recentSummaries.push(`Turn ${turn.turn}: ${turn.summary}${turn.goal ? ` — ${turn.goal}` : ""}`);
  if (recentSummaries.length >= 100) {
    contextEpoch++;
    await fs.writeFile(path.join(TURNS_DIR, `summary-${contextEpoch}.md`), recentSummaries.map(x => `- ${x}`).join("\n") + "\n", "utf8");
    recentSummaries = [`Archived summary-${contextEpoch}.md`];
  }
  await fs.writeFile(CONTEXT_FILE, `# TUI Driver Long-Term Context\n\n- Play autonomously; never ask humans for input.\n- Save often when safe.\n- Keep inner dialogue minimal.\n- Prefer adventurous/story-rich choices when appropriate.\n- Every ~20 turns, wait around 30 seconds if safe.\n\n## Recent Turns\n\n${recentSummaries.map(x => `- ${x}`).join("\n")}\n`, "utf8");
}).pipe(Effect.catchAll(() => Effect.void));
async function writeTurnFile(turn: Turn, s: any) { return run(writeTurnFileEffect(turn, s)); }

const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Pi TUI Driver</title><style>
:root{--text:#dce7df;--muted:#8a9a92;--accent:#7fffd4;--gold:#f1c96b}html,body{margin:0;height:100%;overflow:hidden;background:#000!important;color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}#game{width:100vw;height:100vh;box-sizing:border-box;margin:0;white-space:pre!important;background:#000!important;color:#d8d8d8!important;padding:48px 22px 54px;border:0;font-size:16px;line-height:1.05;overflow:hidden}#game *{background-color:transparent}#topMarquee{position:fixed;top:0;left:0;right:0;z-index:4;height:28px;overflow:hidden;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,.58),rgba(0,0,0,0))}#topMarqueeInner{display:inline-block;white-space:nowrap;padding-top:5px;color:rgba(127,255,212,.78);font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-shadow:0 1px 6px #000;animation:topScroll 18s linear infinite}@keyframes topScroll{from{transform:translateX(100vw)}to{transform:translateX(-100%)}}#overlay{position:fixed;left:0;right:0;bottom:0;z-index:4;padding:6px 11px 8px;box-sizing:border-box;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.16) 45%,rgba(0,0,0,.28));pointer-events:none}#marquee{display:flex;gap:6px;align-items:stretch;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;pointer-events:auto}#marquee::-webkit-scrollbar{display:none}.event{flex:0 0 235px;min-height:39px;border:1px solid rgba(127,255,212,.14);border-radius:8px;padding:5px 7px;background:rgba(17,21,20,.42);color:rgba(220,231,223,.78);cursor:pointer;font:inherit;text-align:left;box-shadow:0 6px 16px rgba(0,0,0,.18);backdrop-filter:blur(3px);opacity:.74}.event:hover{border-color:rgba(127,255,212,.55);opacity:.98;background:rgba(17,21,20,.82)}.event.active{border-color:var(--accent)}.eventTop{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px}.turn{color:var(--accent);font-weight:800;font-size:10px}.summary{color:var(--gold);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.goal{font-size:10px;line-height:1.12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.narration{color:var(--muted);font-size:9px;line-height:1.12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#message{position:fixed;left:18px;bottom:68px;z-index:5;color:rgba(220,231,223,.6);font-size:10px;text-shadow:0 1px 4px #000;pointer-events:none}#header{position:fixed;top:12px;left:14px;right:14px;z-index:3;display:flex;justify-content:space-between;color:rgba(220,231,223,.55);font-size:12px;pointer-events:none;text-shadow:0 1px 4px #000}
</style></head><body><div id="topMarquee"><div id="topMarqueeInner">powered by pi.dev ✦ powered by pi.dev ✦ powered by pi.dev ✦</div></div><div id="header"><span id="viewLabel">Live output</span><span>Pi TUI Driver</span></div><pre id="game">connecting...</pre><div id="message"></div><div id="overlay"><div id="marquee"></div></div><script>
let selectedTurn=null,latestState=null;async function tick(){try{latestState=await(await fetch('/api/state')).json();render()}catch(e){message.textContent=String(e)}}function render(){const s=latestState||{screen:'',actions:[]};const sel=selectedTurn==null?null:(s.actions||[]).find(a=>a.turn===selectedTurn);const html=sel?sel.screen_html:s.screen_html;if(html)game.innerHTML=html;else game.textContent=sel?sel.screen:(s.screen||'');viewLabel.textContent=sel?('Viewing turn '+sel.turn+' snapshot'):'Live output';message.textContent=s.message||'';const items=(s.actions||[]).slice().reverse().slice(0,20);marquee.innerHTML=items.length?items.map(a=>'<button class="event '+(selectedTurn===a.turn?'active':'')+'" data-turn="'+a.turn+'"><div class="eventTop"><span class="turn">Turn '+a.turn+'</span><span class="summary">'+esc(a.summary)+'</span></div><div class="goal">'+esc(a.goal||'No explicit goal')+'</div>'+(a.narration?'<div class="narration">'+esc(a.narration)+'</div>':'')+'</button>').join(''):'';for(const el of marquee.querySelectorAll('[data-turn]'))el.onclick=()=>{const t=Number(el.dataset.turn);selectedTurn=selectedTurn===t?null:t;render()}}function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}setInterval(tick,250);tick();
</script></body></html>`;
