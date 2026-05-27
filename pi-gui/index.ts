import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const OUT_DIR = path.resolve(process.cwd(), "gui-captures");
const DEFAULT_FORMAT = "png";

type CaptureTarget = "screen" | "foreground_app";

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);
const tryPromise = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (cause) => cause });

const execFileEffect = (file: string, args: string[]) =>
  tryPromise(() => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  }));

const ensureOutDir = () => tryPromise(() => fs.mkdir(OUT_DIR, { recursive: true }));

const platformCheck = () => Effect.gen(function* () {
  if (process.platform !== "darwin") {
    return yield* Effect.fail(new Error("pi-gui currently supports macOS via screencapture. Linux/Windows backends can be added next."));
  }
});

const foregroundAppName = () => Effect.gen(function* () {
  yield* platformCheck();
  const script = 'tell application "System Events" to get name of first application process whose frontmost is true';
  const { stdout } = yield* execFileEffect("osascript", ["-e", script]);
  return stdout.trim();
});

const focusApplication = (appName: string) => Effect.gen(function* () {
  yield* platformCheck();
  const safe = appName.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  yield* execFileEffect("osascript", ["-e", `tell application "${safe}" to activate`]);
  yield* Effect.sleep("500 millis");
});

const captureScreenshot = (options: { target?: CaptureTarget; app?: string; display?: number; name?: string }) => Effect.gen(function* () {
  yield* platformCheck();
  yield* ensureOutDir();

  if (options.app) yield* focusApplication(options.app);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = options.name?.replace(/[^a-zA-Z0-9_.-]/g, "_") || `screenshot-${stamp}`;
  const filePath = path.join(OUT_DIR, `${baseName}.${DEFAULT_FORMAT}`);

  const args = ["-x", "-t", DEFAULT_FORMAT];
  if (typeof options.display === "number") args.push("-D", String(options.display));
  args.push(filePath);
  yield* execFileEffect("screencapture", args);

  const data = yield* tryPromise(() => fs.readFile(filePath));
  const frontmost = yield* foregroundAppName().pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  return {
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    mediaType: "image/png",
    base64: data.toString("base64"),
    frontmost,
    target: options.target ?? "screen",
    app: options.app,
    display: options.display,
  };
});

const captureSeries = (options: { seconds?: number; intervalMs?: number; app?: string; display?: number }) => Effect.gen(function* () {
  const seconds = Math.max(1, Math.min(30, options.seconds ?? 5));
  const intervalMs = Math.max(250, Math.min(5000, options.intervalMs ?? 1000));
  const count = Math.max(1, Math.floor((seconds * 1000) / intervalMs));
  const captures: Array<{ path: string; relativePath: string }> = [];
  for (let i = 0; i < count; i++) {
    const shot = yield* captureScreenshot({ app: options.app, display: options.display, name: `series-${Date.now()}-${i}` });
    captures.push({ path: shot.path, relativePath: shot.relativePath });
    if (i + 1 < count) yield* Effect.sleep(`${intervalMs} millis` as any);
  }
  return { count, seconds, intervalMs, captures, latest: captures.at(-1) };
});

const listApps = () => Effect.gen(function* () {
  yield* platformCheck();
  const script = 'tell application "System Events" to get name of every application process whose background only is false';
  const { stdout } = yield* execFileEffect("osascript", ["-e", script]);
  return stdout.split(", ").map((s) => s.trim()).filter(Boolean).sort();
});

function imageResult(shot: Awaited<ReturnType<typeof run<any>>>) {
  return {
    content: [
      { type: "text", text: `Captured ${shot.relativePath}${shot.frontmost ? ` (frontmost: ${shot.frontmost})` : ""}` },
      { type: "image", source: { type: "base64", mediaType: shot.mediaType, data: shot.base64 } },
    ],
    details: { path: shot.path, relativePath: shot.relativePath, frontmost: shot.frontmost, target: shot.target, app: shot.app, display: shot.display },
  };
}

export default function(pi: ExtensionAPI) {
  void fs.mkdir(OUT_DIR, { recursive: true });

  pi.registerCommand("gui-screenshot", {
    description: "Capture the screen or an app. Usage: /gui-screenshot [App Name]",
    handler: async (args, ctx) => {
      try {
        const app = (args || "").trim() || undefined;
        const shot = await run(captureScreenshot({ app, target: app ? "foreground_app" : "screen" }));
        ctx.ui.notify(`Captured ${shot.relativePath}`, "info");
      } catch (error) {
        ctx.ui.notify(`GUI screenshot failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("gui-apps", {
    description: "List visible GUI applications.",
    handler: async (_args, ctx) => {
      try { ctx.ui.notify((await run(listApps())).join(", ") || "No apps found", "info"); }
      catch (error) { ctx.ui.notify(`GUI app list failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });

  pi.registerTool({
    name: "gui_screenshot",
    label: "GUI Screenshot",
    description: "Capture the full screen, optionally focusing an application first. macOS may require Screen Recording permission for Terminal/Pi.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: "Optional app name to activate before capturing, e.g. OBS, Safari, Dwarf Fortress" })),
      display: Type.Optional(Type.Number({ description: "macOS display number for screencapture -D" })),
    }),
    async execute(_id, params) {
      const shot = await run(captureScreenshot({ app: params.app, display: params.display, target: params.app ? "foreground_app" : "screen" }));
      return imageResult(shot);
    },
  });

  pi.registerTool({
    name: "gui_foreground_app",
    label: "GUI Foreground App",
    description: "Return the currently focused GUI application name.",
    parameters: Type.Object({}),
    async execute() {
      const app = await run(foregroundAppName());
      return { content: [{ type: "text", text: app }], details: { app } };
    },
  });

  pi.registerTool({
    name: "gui_list_apps",
    label: "GUI List Apps",
    description: "List visible GUI applications.",
    parameters: Type.Object({}),
    async execute() {
      const apps = await run(listApps());
      return { content: [{ type: "text", text: apps.join("\n") }], details: { apps } };
    },
  });

  pi.registerTool({
    name: "gui_capture_series",
    label: "GUI Capture Series",
    description: "Capture a short screenshot series to disk and return the file list. Useful as lightweight screen-recording/sampling.",
    parameters: Type.Object({
      seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
      intervalMs: Type.Optional(Type.Number({ minimum: 250, maximum: 5000 })),
      app: Type.Optional(Type.String()),
      display: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const result = await run(captureSeries(params));
      return {
        content: [{ type: "text", text: `Captured ${result.count} frames:\n${result.captures.map((c) => c.relativePath).join("\n")}` }],
        details: result,
      };
    },
  });
}
