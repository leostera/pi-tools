# pi-tui

A pi.dev extension that lets Pi drive terminal/TUI applications continuously.

`pi-tui` owns a PTY process, captures its terminal screen with `xterm-headless`, exposes typed Pi tools for observation/input, and serves a local web overlay for watching the session in a browser or OBS.

## Install dependencies

```sh
npm install
npm rebuild node-pty --build-from-source
```

## Use in this repo

This repo includes a project-local shim at `.pi/extensions/pi-tui/index.ts`, so Pi auto-loads the extension from the repo root.

```sh
pi
```

Then run a TUI app:

```txt
/tui run nethack
```

Or with explicit terminal size:

```txt
/tui run --cols 140 --rows 40 nethack
```

Run a remote TUI over SSH:

```txt
/tui run --cols 140 --rows 40 ssh -tt starbase2 dwarffortress
```

Open the overlay:

```txt
http://127.0.0.1:7777
```

## Commands

```txt
/tui run [--port 7777] [--cols 140] [--rows 40] <command>
/tui status
/tui stop
```

## Pi tools

- `tui_observe`
- `tui_press_key`
- `tui_press_sequence`
- `tui_wait`
- `tui_narrate`
- `tui_noop`

## Notes

- The extension does **not** auto-start on load. Use `/tui run ...` explicitly.
- Per-turn notes are written to `turns/{n}.md`.
- Long-term context is maintained in `context.md`.
- Every 100 summaries are archived to `turns/summary-{n}.md` to avoid unbounded context growth.
