import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";
import OBSWebSocket from "obs-websocket-js";

const DEFAULT_URL = process.env.OBS_WEBSOCKET_URL ?? "ws://127.0.0.1:4455";
const DEFAULT_PASSWORD = process.env.OBS_WEBSOCKET_PASSWORD;

let obs = new OBSWebSocket();
let connected = false;
let url = DEFAULT_URL;
let password: string | undefined = DEFAULT_PASSWORD;
let lastError: string | undefined;

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect);
const tryPromise = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (cause) => cause });

function resetClient() {
  try { obs.disconnect(); } catch {}
  obs = new OBSWebSocket();
  connected = false;
  obs.on("ConnectionClosed", () => { connected = false; });
}

const ensureConnected = () => Effect.gen(function* () {
  if (connected) return;
  try {
    yield* tryPromise(() => obs.connect(url, password));
    connected = true;
    lastError = undefined;
  } catch (error) {
    connected = false;
    lastError = error instanceof Error ? error.message : String(error);
    return yield* Effect.fail(error);
  }
});

const obsCall = (requestType: string, requestData?: object) => Effect.gen(function* () {
  yield* ensureConnected();
  return yield* tryPromise(() => obs.call(requestType as any, requestData as any));
});

const streamStatus = () => Effect.gen(function* () {
  const [stream, version, scene] = yield* Effect.all([
    obsCall("GetStreamStatus"),
    obsCall("GetVersion").pipe(Effect.catchAll(() => Effect.succeed({}))),
    obsCall("GetCurrentProgramScene").pipe(Effect.catchAll(() => Effect.succeed({}))),
  ] as const);
  return { connected, url, stream, version, scene, lastError };
});

const startStream = () => Effect.gen(function* () {
  const before: any = yield* obsCall("GetStreamStatus");
  if (!before.outputActive) yield* obsCall("StartStream");
  const after = yield* obsCall("GetStreamStatus");
  return { started: !before.outputActive, before, after };
});

const stopStream = () => Effect.gen(function* () {
  const before: any = yield* obsCall("GetStreamStatus");
  if (before.outputActive) yield* obsCall("StopStream");
  const after = yield* obsCall("GetStreamStatus");
  return { stopped: before.outputActive, before, after };
});

function statusText(status: any): string {
  const stream = status.stream ?? {};
  const scene = status.scene ?? {};
  return [
    `OBS ${status.connected ? "connected" : "disconnected"} ${status.url}`,
    `stream=${stream.outputActive ? "live" : "stopped"}`,
    stream.outputTimecode ? `time=${stream.outputTimecode}` : undefined,
    scene.currentProgramSceneName ? `scene=${scene.currentProgramSceneName}` : undefined,
    status.lastError ? `lastError=${status.lastError}` : undefined,
  ].filter(Boolean).join(" | ");
}

export default function(pi: ExtensionAPI) {
  resetClient();

  pi.registerCommand("obs-connect", {
    description: "Connect to OBS websocket. Usage: /obs-connect [ws://127.0.0.1:4455] [password]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      if (parts[0]) url = parts[0];
      if (parts[1]) password = parts[1];
      resetClient();
      try {
        const s = await run(streamStatus());
        ctx.ui.notify(statusText(s), "info");
      } catch (error) {
        ctx.ui.notify(`OBS connect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("obs-status", {
    description: "Show OBS stream/status info.",
    handler: async (_args, ctx) => {
      try { ctx.ui.notify(statusText(await run(streamStatus())), "info"); }
      catch (error) { ctx.ui.notify(`OBS status failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });

  pi.registerCommand("obs-start-stream", {
    description: "Start OBS streaming.",
    handler: async (_args, ctx) => {
      try { const r: any = await run(startStream()); ctx.ui.notify(r.started ? "OBS stream started" : "OBS stream was already live", "info"); }
      catch (error) { ctx.ui.notify(`OBS start stream failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });

  pi.registerCommand("obs-stop-stream", {
    description: "Stop OBS streaming.",
    handler: async (_args, ctx) => {
      try { const r: any = await run(stopStream()); ctx.ui.notify(r.stopped ? "OBS stream stopped" : "OBS stream was already stopped", "info"); }
      catch (error) { ctx.ui.notify(`OBS stop stream failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });

  pi.registerTool({
    name: "obs_stream_status",
    label: "OBS Stream Status",
    description: "Get OBS connection, stream, version, and current scene status.",
    parameters: Type.Object({}),
    async execute() {
      const s = await run(streamStatus());
      return { content: [{ type: "text", text: statusText(s) }], details: s };
    },
  });

  pi.registerTool({
    name: "obs_start_stream",
    label: "OBS Start Stream",
    description: "Start streaming in OBS if it is not already live.",
    parameters: Type.Object({}),
    async execute() {
      const r: any = await run(startStream());
      return { content: [{ type: "text", text: r.started ? "OBS stream started" : "OBS stream was already live" }], details: r };
    },
  });

  pi.registerTool({
    name: "obs_stop_stream",
    label: "OBS Stop Stream",
    description: "Stop streaming in OBS if it is currently live.",
    parameters: Type.Object({}),
    async execute() {
      const r: any = await run(stopStream());
      return { content: [{ type: "text", text: r.stopped ? "OBS stream stopped" : "OBS stream was already stopped" }], details: r };
    },
  });
}
