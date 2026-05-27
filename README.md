# pi-tools

A monorepo/workspace for Pi extensions and tools.

## Extensions

### `pi-tui`

A pi.dev extension that lets Pi drive terminal/TUI applications via a managed PTY and a local web overlay.

Run from the repo root:

```sh
npm install
npm run build
pi
```

Then inside Pi:

```txt
/tui-run nethack
/tui-status
/tui-stop
```

With explicit terminal size:

```txt
/tui-run --cols 140 --rows 40 nethack
```

Remote TUI over SSH:

```txt
/tui-run --cols 140 --rows 40 ssh -tt starbase2 dwarffortress
```

Open the overlay:

```txt
http://127.0.0.1:7777
```

The project-local shim at `.pi/extensions/pi-tui/index.ts` loads `pi-tui/index.ts`, so Pi auto-discovers it when started from the repo root.

### `pi-obs`

A pi.dev extension for controlling OBS Studio via obs-websocket.

OBS Studio must have WebSocket enabled, usually at:

```txt
ws://127.0.0.1:4455
```

Optional environment variables:

```sh
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=your_password
```

Commands inside Pi:

```txt
/obs-connect [url] [password]
/obs-status
/obs-start-stream
/obs-stop-stream
```

Tools registered for agents:

- `obs_stream_status`
- `obs_start_stream`
- `obs_stop_stream`

The project-local shim at `.pi/extensions/pi-obs/index.ts` loads `pi-obs/index.ts`.

### `pi-gui`

A pi.dev extension for observing GUI applications via screenshots/screen sampling.

Current backend: macOS `screencapture` + `osascript`. You may need to grant Screen Recording permission to your terminal/Pi app in macOS Privacy & Security settings.

Commands inside Pi:

```txt
/gui-screenshot [App Name]
/gui-apps
```

Tools registered for agents:

- `gui_screenshot`
- `gui_foreground_app`
- `gui_list_apps`
- `gui_capture_series`

Captures are written to `gui-captures/` and ignored by git.

The project-local shim at `.pi/extensions/pi-gui/index.ts` loads `pi-gui/index.ts`.

## Workspace commands

```sh
npm run build   # rebuild native deps and validate imports
npm run check   # validate imports without rebuild
```

## Future ideas

- `pi-pi`: use Pi to supervise/control other Pi agents.
- `pi-gui`: like `pi-tui`, but observes and controls graphical desktop applications.
