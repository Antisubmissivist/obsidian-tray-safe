"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, normalizePath, moment } = require("obsidian");

// Obsidian ships @electron/remote and shims it onto `electron.remote`.
// Probe both, never assume — Electron 43 removed the built-in remote module.
const getRemote = () => {
  try {
    const e = require("electron");
    if (e && e.remote && e.remote.getCurrentWindow) return e.remote;
  } catch (_) {}
  try {
    const r = require("@electron/remote");
    if (r && r.getCurrentWindow) return r;
  } catch (_) {}
  return null;
};

const ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB4klEQVR42n2TvWuUQRDGf7O777734SGCEjBpPFAQRAULq9T+B4Ih2tiZf0CweBEOGxsb+xA8UliksrA2YJUQ0igckYAGIwYEEy/38b47FnsX75LzBhaWmXmemXl2RxixbEHrLqXe6WE0ILhBIAcxqE/QPuw2lqUVAyqSZWouf8d+bfPKGh4CNaaZ8CcE3ppfLHGHjgA8W9TX56s8OWxHWuQ/YI0UtQr8PqLZaMqiPF3QujN8Mgbb7SB5HzOtAZegPiWg2NxwyxnLVWvw3S46ewW5NDuoJBOqC/zcQ/Z2kUoZQo/rDkAEQoDaBZirg2r0jeEHvk4bdCfeRVAHoAF8Cp83YPtjLK5ntIs+78GXIiFw8lCoQlqGcvUseJQkBCiKEU1OggL9HuR9MGZcBh0BuwSsO0UgAnkPLs7AvQdQqvwjHXYHcf73q3CwDz4ZJTDQPYbb83Dj7tRvxI9v8G4FqtUBgSiiIc6/tQ4zc9M72PoQc0MAYxAnBTu5knuPHOxjVl4iQw0mCWgTNPFoUUAeaJnGqrQU3pwrY52DtEJISgR/6iQlQlohOIfWytigrL1oyqbLMjVssHRocM5yH/AyZRcKJT86Zq3f5bGqjqdmj/QmcK0oJu+D94RC+fJ8WTaH6/wX9uu62DmQQaIAAAAASUVORK5CYII=";

const DEFAULTS = {
  runInBackground: true,
  launchOnStartup: true,
  hideOnLaunch: false,
  hideTaskbarIcon: false,
  createTrayIcon: true,
  trayIconTooltip: "{{vault}} | Obsidian",
  toggleWindowHotkey: "CmdOrCtrl+Shift+Tab",
  quickNoteHotkey: "CmdOrCtrl+Shift+Q",
  quickNoteFolder: "",
  quickNoteDateFormat: "YYYY-MM-DD",
  forceRepaint: true,
  autoCommit: false,
  commitOnHide: false,
  minCommitIntervalMin: 5,
};

module.exports = class TraySafePlugin extends Plugin {
  async onload() {
    this.remote = getRemote();
    if (!this.remote) {
      new Notice("Tray Safe: Electron remote unavailable — plugin disabled.", 10000);
      console.error("[tray-safe] no remote module; aborting load");
      return;
    }

    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.windows = new Set();
    this.maximized = new Set();
    this.shortcuts = [];
    this.tray = null;
    this.quitting = false;

    this.win = this.remote.getCurrentWindow();
    this.trackWindow(this.win);
    this.onDidCreateWindow = (w) => this.trackWindow(w);
    this.win.webContents.on("did-create-window", this.onDidCreateWindow);

    if (this.settings.createTrayIcon) this.createTray();
    if (this.settings.runInBackground) this.interceptClose();
    this.registerHotkeys();
    this.applyLoginItem();
    this.applyTaskbarPreference();

    if (this.settings.runInBackground && this.settings.hideOnLaunch) {
      // defer: hiding during layout-ready races Obsidian's own window setup
      setTimeout(() => this.hideAll(), 1500);
    }

    this.addCommand({
      id: "hide-to-tray",
      name: "Hide window to tray",
      callback: () => this.hideAll(),
    });
    this.addCommand({
      id: "quick-note",
      name: "Create quick note",
      callback: () => this.quickNote(),
    });

    this.addSettingTab(new TraySafeSettingTab(this.app, this));
    console.log("[tray-safe] loaded, remote OK");
  }

  onunload() {
    this.unregisterHotkeys();
    this.allowClose();
    if (this.tray) {
      try { this.tray.destroy(); } catch (_) {}
      this.tray = null;
    }
    // never leave the user with an invisible window
    for (const win of this.liveWindows()) {
      try {
        win.setSkipTaskbar(false);
        if (win.isMinimized()) win.restore();
      } catch (_) {}
    }
    if (this.win && this.onDidCreateWindow) {
      try { this.win.webContents.off("did-create-window", this.onDidCreateWindow); } catch (_) {}
    }
  }

  // ---------- window tracking ----------

  trackWindow(win) {
    if (!win || this.windows.has(win)) return;
    this.windows.add(win);
    try {
      if (win.isMaximized()) this.maximized.add(win);
      win.on("maximize", () => this.maximized.add(win));
      win.on("unmaximize", () => this.maximized.delete(win));
      win.on("closed", () => {
        this.windows.delete(win);
        this.maximized.delete(win);
      });
    } catch (e) {
      console.error("[tray-safe] trackWindow failed", e);
    }
  }

  liveWindows() {
    return [...(this.windows || [])].filter((w) => {
      try { return !w.isDestroyed(); } catch (_) { return false; }
    });
  }

  // ---------- the whole point: minimise, never hide ----------

  hideAll() {
    for (const win of this.liveWindows()) {
      try {
        if (win.isMaximized()) this.maximized.add(win);
        if (win.isFocused()) win.blur();
        win.setSkipTaskbar(true);
        win.minimize();
      } catch (e) {
        console.error("[tray-safe] hide failed", e);
      }
    }
    if (this.settings.commitOnHide) this.gitCommit({ reason: "hide", sync: false });
  }

  // ---------- auto commit: one work session = one commit ----------

  vaultPath() {
    const a = this.app.vault.adapter;
    try {
      if (typeof a.getBasePath === "function") return a.getBasePath();
      if (a.basePath) return a.basePath;
    } catch (_) {}
    return null;
  }

  // Returns: null = not applicable, 0 = nothing to commit, n = files committed,
  // -1 = failed (and the user was told). Never fails silently.
  gitCommit({ reason, sync }) {
    if (!this.settings.autoCommit) return null;
    const base = this.vaultPath();
    if (!base) return null;

    const now = Date.now();
    const gap = (this.settings.minCommitIntervalMin || 0) * 60000;
    if (!sync && this.lastCommit && now - this.lastCommit < gap) return null;

    const cp = require("child_process");
    const opts = { cwd: base, encoding: "utf8", timeout: 30000, windowsHide: true };
    const gitSync = (args) => cp.execFileSync("git", args, opts);

    try {
      gitSync(["rev-parse", "--is-inside-work-tree"]);
    } catch (_) {
      return null; // not a git repo - stay quiet, not every vault is one
    }

    let status;
    try {
      status = gitSync(["status", "--porcelain"]).trim();
    } catch (e) {
      console.error("[tray-safe] git status failed", e);
      new Notice("Tray Safe: git status 失败,自动提交已跳过(见控制台)", 8000);
      return -1;
    }
    if (!status) return 0;

    const lines = status.split(/\r?\n/).filter(Boolean);
    const names = lines.slice(0, 3).map((l) => l.slice(3).replace(/^"|"$/g, "").split("/").pop());
    const more = lines.length > 3 ? " +" + (lines.length - 3) : "";
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const msg = `auto(${reason}) ${stamp} · ${lines.length} changes: ${names.join(", ")}${more}`;

    const finish = (err) => {
      if (err) {
        console.error("[tray-safe] auto-commit failed", err);
        new Notice("Tray Safe: 自动 commit 失败,改动未入库(见控制台)", 10000);
        return -1;
      }
      this.lastCommit = Date.now();
      console.log(`[tray-safe] auto-commit: ${lines.length} changes (${reason})`);
      return lines.length;
    };

    if (sync) {
      try {
        gitSync(["add", "-A"]);
        gitSync(["commit", "-m", msg]);
        return finish(null);
      } catch (e) {
        return finish(e);
      }
    }
    // async path: don't block the window from minimising
    cp.execFile("git", ["add", "-A"], opts, (e1) => {
      if (e1) return finish(e1);
      cp.execFile("git", ["commit", "-m", msg], opts, (e2) => finish(e2));
    });
    return lines.length;
  }

  showAll() {
    for (const win of this.liveWindows()) {
      try {
        win.setSkipTaskbar(this.settings.hideTaskbarIcon);
        if (win.isMinimized()) win.restore();
        if (this.maximized.has(win) && !win.isMaximized()) win.maximize();
        win.focus();
        if (this.settings.forceRepaint) this.repaint(win);
      } catch (e) {
        console.error("[tray-safe] show failed", e);
      }
    }
  }

  isAnyVisible() {
    return this.liveWindows().some((w) => {
      try { return w.isVisible() && !w.isMinimized(); } catch (_) { return false; }
    });
  }

  toggle() {
    if (this.isAnyVisible()) this.hideAll();
    else this.showAll();
  }

  // Belt-and-braces repaint nudge. Should be unnecessary with minimise/restore,
  // but costs ~1 frame and covers compositor stalls on hybrid-GPU laptops.
  repaint(win) {
    try {
      win.webContents.invalidate();
      return;
    } catch (_) {}
    try {
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height + 1 });
      setTimeout(() => { try { win.setBounds(b); } catch (_) {} }, 16);
    } catch (_) {}
  }

  // ---------- keep alive on window close ----------

  interceptClose() {
    if (this.onBeforeUnload) return;
    this.onBeforeUnload = (event) => {
      if (this.quitting) return;
      this.hideAll();
      event.stopImmediatePropagation();
      event.returnValue = false;
    };
    this.onMainClose = (event) => {
      if (this.quitting) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", this.onBeforeUnload, true);
    // also intercept in main: counteracts Obsidian's 3s delayed force-close
    this.win.on("close", this.onMainClose);
  }

  allowClose() {
    if (this.onBeforeUnload) {
      window.removeEventListener("beforeunload", this.onBeforeUnload, true);
      this.onBeforeUnload = null;
    }
    if (this.onMainClose && this.win) {
      try { this.win.removeListener("close", this.onMainClose); } catch (_) {}
      this.onMainClose = null;
    }
  }

  quit() {
    this.quitting = true;
    // synchronous on purpose: app.quit() must not race the commit
    this.gitCommit({ reason: "quit", sync: true });
    this.allowClose();
    if (this.tray) {
      try { this.tray.destroy(); } catch (_) {}
      this.tray = null;
    }
    this.unregisterHotkeys();
    try {
      this.remote.app.quit();
    } catch (_) {
      try { this.win.destroy(); } catch (_) {}
    }
  }

  // ---------- tray ----------

  createTray() {
    const { Tray, Menu, nativeImage } = this.remote;
    try {
      const image = nativeImage.createFromDataURL(ICON);
      this.tray = new Tray(image);
      this.tray.setToolTip(
        this.settings.trayIconTooltip.replace("{{vault}}", this.app.vault.getName())
      );
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Show / hide", click: () => this.toggle() },
          { label: "Quick note", click: () => this.quickNote() },
          { type: "separator" },
          { label: "Quit Obsidian", click: () => this.quit() },
        ])
      );
      this.tray.on("click", () => this.toggle());
    } catch (e) {
      console.error("[tray-safe] tray creation failed", e);
      new Notice("Tray Safe: could not create tray icon — see console.", 8000);
    }
  }

  applyTaskbarPreference() {
    for (const win of this.liveWindows()) {
      try { win.setSkipTaskbar(this.settings.hideTaskbarIcon); } catch (_) {}
    }
  }

  applyLoginItem() {
    try {
      this.remote.app.setLoginItemSettings({
        openAtLogin: this.settings.launchOnStartup,
        openAsHidden: this.settings.runInBackground && this.settings.hideOnLaunch,
      });
    } catch (e) {
      console.error("[tray-safe] setLoginItemSettings failed", e);
    }
  }

  // ---------- hotkeys ----------

  registerHotkeys() {
    const { globalShortcut } = this.remote;
    const bind = (accel, fn) => {
      if (!accel) return;
      try {
        if (globalShortcut.register(accel, fn)) this.shortcuts.push(accel);
        else new Notice("Tray Safe: hotkey \"" + accel + "\" is taken by another app.", 8000);
      } catch (e) {
        console.error("[tray-safe] hotkey register failed", accel, e);
      }
    };
    bind(this.settings.toggleWindowHotkey, () => this.toggle());
    bind(this.settings.quickNoteHotkey, () => this.quickNote());
  }

  unregisterHotkeys() {
    if (!this.remote) return;
    const { globalShortcut } = this.remote;
    for (const accel of this.shortcuts || []) {
      try { globalShortcut.unregister(accel); } catch (_) {}
    }
    this.shortcuts = [];
  }

  // ---------- quick note ----------

  async quickNote() {
    this.showAll();
    try {
      const folder = (this.settings.quickNoteFolder || "").trim().replace(/^\/+|\/+$/g, "");
      const base = moment().format(this.settings.quickNoteDateFormat);
      if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
        await this.app.vault.createFolder(normalizePath(folder)).catch(() => {});
      }
      const path = normalizePath((folder ? folder + "/" : "") + base + ".md");
      let file = this.app.vault.getAbstractFileByPath(path);
      if (!file) {
        // never clobber: if create races, fall back to a numbered suffix
        try {
          file = await this.app.vault.create(path, "");
        } catch (_) {
          for (let i = 1; i < 100; i++) {
            const alt = normalizePath((folder ? folder + "/" : "") + base + " " + i + ".md");
            if (!this.app.vault.getAbstractFileByPath(alt)) {
              file = await this.app.vault.create(alt, "");
              break;
            }
          }
        }
      }
      if (file) await this.app.workspace.getLeaf(true).openFile(file);
    } catch (e) {
      console.error("[tray-safe] quick note failed", e);
      new Notice("Tray Safe: quick note failed — see console.", 6000);
    }
  }

  async save() {
    await this.saveData(this.settings);
  }
};

class TraySafeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl("p", {
      text:
        "Hides by minimising instead of Electron's hide(), so the GPU compositing surface is never destroyed. Hotkey, tray and taskbar changes apply immediately.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Run in background")
      .setDesc("Closing the window hides it to the tray instead of quitting Obsidian.")
      .addToggle((t) =>
        t.setValue(s.runInBackground).onChange(async (v) => {
          s.runInBackground = v;
          await this.plugin.save();
          if (v) this.plugin.interceptClose();
          else this.plugin.allowClose();
          this.plugin.applyLoginItem();
        })
      );

    new Setting(containerEl)
      .setName("Launch on startup")
      .addToggle((t) =>
        t.setValue(s.launchOnStartup).onChange(async (v) => {
          s.launchOnStartup = v;
          await this.plugin.save();
          this.plugin.applyLoginItem();
        })
      );

    new Setting(containerEl)
      .setName("Hide on launch")
      .setDesc("Start minimised to the tray.")
      .addToggle((t) =>
        t.setValue(s.hideOnLaunch).onChange(async (v) => {
          s.hideOnLaunch = v;
          await this.plugin.save();
          this.plugin.applyLoginItem();
        })
      );

    new Setting(containerEl)
      .setName("Hide taskbar icon")
      .setDesc("Keep Obsidian out of the taskbar while its window is visible.")
      .addToggle((t) =>
        t.setValue(s.hideTaskbarIcon).onChange(async (v) => {
          s.hideTaskbarIcon = v;
          await this.plugin.save();
          this.plugin.applyTaskbarPreference();
        })
      );

    new Setting(containerEl)
      .setName("Force repaint on restore")
      .setDesc("Extra safety nudge for hybrid-GPU laptops. Leave on unless you see flicker.")
      .addToggle((t) =>
        t.setValue(s.forceRepaint).onChange(async (v) => {
          s.forceRepaint = v;
          await this.plugin.save();
        })
      );

    containerEl.createEl("h3", { text: "自动提交 (Git)" });
    containerEl.createEl("p", {
      text:
        "一次使用周期 = 一个 commit,而不是定时快照。仅在 vault 本身是 git 仓库时生效;不是仓库则静默跳过。失败会弹提示,不会假装成功。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("启用自动提交")
      .setDesc("退出 Obsidian 时提交(同步执行,确保写完再退)。")
      .addToggle((t) =>
        t.setValue(s.autoCommit).onChange(async (v) => {
          s.autoCommit = v;
          await this.plugin.save();
        })
      );

    new Setting(containerEl)
      .setName("隐藏到托盘时也提交")
      .setDesc("关窗/热键收起时提交一次(异步,不卡窗口)。")
      .addToggle((t) =>
        t.setValue(s.commitOnHide).onChange(async (v) => {
          s.commitOnHide = v;
          await this.plugin.save();
        })
      );

    new Setting(containerEl)
      .setName("最小提交间隔(分钟)")
      .setDesc("防止反复开关窗刷出一堆 commit。退出时忽略此限制。")
      .addText((t) =>
        t.setValue(String(s.minCommitIntervalMin)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.minCommitIntervalMin = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.save();
        })
      );

    new Setting(containerEl)
      .setName("立即提交一次")
      .setDesc("用来验证配置是否可用。")
      .addButton((b) =>
        b.setButtonText("Commit now").onClick(() => {
          const r = this.plugin.gitCommit({ reason: "manual", sync: true });
          if (r === null) new Notice("跳过:未启用,或 vault 不是 git 仓库");
          else if (r === 0) new Notice("没有变更,无需提交");
          else if (r > 0) new Notice(`已提交 ${r} 处变更`);
        })
      );

    const hotkey = (name, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc("Electron accelerator, e.g. CmdOrCtrl+Shift+Q. Empty to disable. Applies immediately.")
        .addText((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim();
            await this.plugin.save();
            this.plugin.unregisterHotkeys();
            this.plugin.registerHotkeys();
          })
        );

    hotkey("Show / hide hotkey", "toggleWindowHotkey");
    hotkey("Quick note hotkey", "quickNoteHotkey");

    new Setting(containerEl)
      .setName("Quick note folder")
      .setDesc("Vault-relative path. Empty = vault root.")
      .addText((t) =>
        t.setValue(s.quickNoteFolder).onChange(async (v) => {
          s.quickNoteFolder = v;
          await this.plugin.save();
        })
      );

    new Setting(containerEl)
      .setName("Quick note filename format")
      .setDesc("Moment.js format, e.g. YYYY-MM-DD.")
      .addText((t) =>
        t.setValue(s.quickNoteDateFormat).onChange(async (v) => {
          s.quickNoteDateFormat = v;
          await this.plugin.save();
        })
      );
  }
}
