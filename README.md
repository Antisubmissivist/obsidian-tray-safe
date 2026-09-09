<p align="center">
  <img src="icon.png" width="96" alt="Tray Safe">
</p>

<h1 align="center">Tray Safe</h1>

<p align="center">Run Obsidian from the system tray — and always get your window back.</p>

---

## The problem

Tray plugins keep Obsidian alive in the background by calling Electron's `BrowserWindow.hide()`. That works, until it doesn't:

- the window comes back **completely black**, but the process is still running
- clicking the tray icon does nothing at all
- clicking the taskbar shortcut opens the vault switcher instead of your vault
- a maximised window comes back at its old, smaller size

The only way out is Task Manager. Some people have had to end the process and hand-edit `data.json` just to get Obsidian to open in the foreground again.

These are real, long-standing reports against the existing tray plugin — see [#40 (settings combination makes the app inaccessible)](https://github.com/dragonwocky/obsidian-tray/issues/40), [#48 (tray icon suddenly stops opening the window)](https://github.com/dragonwocky/obsidian-tray/issues/48), [#73 (window stays hidden when clicking the taskbar shortcut)](https://github.com/dragonwocky/obsidian-tray/issues/73) and [#22 (maximised windows not preserved)](https://github.com/dragonwocky/obsidian-tray/issues/22).

## The idea

`hide()` unmaps the window from the window manager, and Chromium tears down its compositing surface along with it. Bringing it back means rebuilding that surface — and on some setups (hybrid-GPU laptops in particular) the rebuild is where things go wrong.

`minimize()` never unmaps the window. The surface is never destroyed, so there is nothing to rebuild.

Same visible result — the window disappears, only the tray icon remains — but the window is always still there.

|  | Typical tray plugin | Tray Safe |
|---|---|---|
| Hiding | `win.hide()` | `win.minimize()` + `setSkipTaskbar(true)` |
| Restoring | `win.show()` | `restore()` → re-`maximize()` if it was maximised → `focus()` |
| Compositing surface | destroyed, then rebuilt | never destroyed |
| Maximised state | often lost | tracked per window and restored |
| Extra safety | — | optional repaint nudge on restore |

### This isn't a hypothetical difference

Every other tray plugin in the community store hides the same way. Counted by grepping the `main.js` of each plugin's latest release (2026-09-09):

| Plugin | `.hide(` | `.minimize(` |
|---|---|---|
| [tray](https://github.com/dragonwocky/obsidian-tray) | 4 | 1 · only the `runInBackground: false` fallback |
| [background-tray](https://github.com/synaphi/background-tray) | 5 | 0 |
| [omarchy-tray](https://github.com/lopezjuanma96/omarchy-tray) | 5 | 0 |
| [traystone](https://github.com/tinswangtao-web/traystone) | 4 | 1 · same fallback |
| [mini-tray](https://github.com/wangdamon6-hub/obsidian-mini-tray) | 2 | 0 |
| **Tray Safe** | **0** | primary strategy |

Not a criticism of any of them — `hide()` is the obvious call to reach for, and it works fine on most machines. But if it's the one that breaks on yours, every one of those plugins breaks the same way.

## Features

- **Tray icon** with show/hide, quick note, and quit
- **Run in background** — closing the window hides it to the tray instead of quitting
- **Launch on startup**, optionally starting hidden
- **Global hotkeys** for show/hide and for creating a quick note from anywhere
- **Quick notes** with a configurable folder and filename format
- **Hide taskbar icon** while the window is visible, if you want the tray to be the only entry point
- **Optional Git auto-commit** — off by default, see below
- Commands in the palette: *Hide window to tray*, *Create quick note*

## Install

### Manually

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/Antisubmissivist/obsidian-tray-safe/releases/latest)
2. Create a folder `<your vault>/.obsidian/plugins/tray-safe/`
3. Put both files in it
4. Restart Obsidian (or *Settings → Community plugins → Reload plugins*)
5. Enable **Tray Safe**

### Via BRAT

Add `Antisubmissivist/obsidian-tray-safe` in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

> ⚠️ Do **not** run this alongside another tray plugin. Both will intercept the window-close event and race for the same global hotkeys. Disable the other one first.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Run in background | on | Closing the window hides it to the tray |
| Launch on startup | on | |
| Hide on launch | off | Start minimised to the tray |
| Hide taskbar icon | off | Keep Obsidian out of the taskbar while visible |
| Force repaint on restore | on | Belt-and-braces nudge for hybrid-GPU laptops; turn off if you see flicker |
| Show / hide hotkey | `CmdOrCtrl+Shift+Tab` | Electron accelerator; empty to disable |
| Quick note hotkey | `CmdOrCtrl+Shift+Q` | Empty to disable |
| Quick note folder | vault root | |
| Quick note filename format | `YYYY-MM-DD` | Moment.js format |

Quitting for real is the **Quit Obsidian** item in the tray menu.

## Optional: Git auto-commit

If your vault is a Git repository, Tray Safe can commit when you quit or hide — **one work session, one commit**, rather than a timer firing every N minutes and burying your history in identical snapshots.

**Off by default.** Enable it in settings if you want it.

- Commits on quit (synchronously, so `app.quit()` can't race it) and optionally on hide (asynchronously, so the window doesn't stall)
- Minimum interval between commits, so toggling the window repeatedly doesn't spam your history — ignored when quitting
- Never creates empty commits
- If the vault isn't a Git repository it stays silent; if a commit **fails** it says so with a notice and a console entry, and never pretends to have succeeded
- It only ever runs `git status`, `git add -A` and `git commit` inside your vault. It has no remote configured by itself and never pushes anywhere.

## Tested on

| | |
|---|---|
| OS | Windows 10 (22H2) |
| Obsidian | 1.13.7 |
| Electron / Chromium | 43.3.0 / 150 |
| GPU | hybrid: NVIDIA RTX 2050 + Intel Iris Xe |

**Not yet verified on macOS or Linux.** The code paths are cross-platform and macOS dock handling is accounted for, but nobody has run it there yet — reports welcome.

**On the root cause, honestly:** the black-window failure was diagnosed by elimination — no display-driver timeout events in the system log, no crash entries, the process alive while the window stayed black. `hide()`/`show()` was the only window-lifecycle call in the path. The mechanism described above is the best-supported explanation, **not something reproduced under a debugger**. What is verifiable is the behavioural difference: this plugin never unmaps the window.

## Credits

The feature set here — tray icon, run in background, global hotkeys, quick notes — follows the ground laid by [dragonwocky/obsidian-tray](https://github.com/dragonwocky/obsidian-tray), which is where this problem was worth solving in the first place. Reading its source is what made the `hide()` vs `minimize()` difference obvious. This is an independent implementation with a different window strategy, not a fork.

## License

[MIT](LICENSE)
