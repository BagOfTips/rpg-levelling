const { Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_DATA = {
  level: 1,
  xp: 0,
  typedCharacters: 0,
  lastKnownLengths: {},
  widgetPosition: "bottom-right",
};

const WIDGET_POSITIONS = [
  {
    value: "bottom-right",
    label: "Bottom right",
  },
  {
    value: "bottom-left",
    label: "Bottom left",
  },
  {
    value: "top-right",
    label: "Top right",
  },
  {
    value: "top-left",
    label: "Top left",
  },
];

module.exports = class RpgLevellingPlugin extends Plugin {
  async onload() {
    this.data = Object.assign(
      {},
      DEFAULT_DATA,
      { lastKnownLengths: {} },
      await this.loadSavedProgress()
    );
    this.data.lastKnownLengths = this.data.lastKnownLengths || {};
    this.data.widgetPosition = this.getValidWidgetPosition(
      this.data.widgetPosition
    );
    this.saveTimer = null;
    this.lastAnimationTimer = null;
    this.widgetHost = null;

    this.addSettingTab(new RpgLevellingSettingTab(this.app, this));

    this.addRibbonIcon("swords", "RPG levelling progress", () => {
      this.showProgressNotice();
    });

    this.createStatusBar();
    this.createFloatingWidget();
    this.moveWidgetToActivePane();
    this.updateUi();
    new Notice("RPG Levelling loaded.");

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        this.handleEditorChange(editor, info);
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.captureActiveFileLength();
        this.moveWidgetToActivePane();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.moveWidgetToActivePane();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.moveWidgetToActivePane();
      })
    );

    this.addCommand({
      id: "show-rpg-levelling-progress",
      name: "Show RPG levelling progress",
      callback: () => {
        this.showProgressNotice();
      },
    });

    this.addCommand({
      id: "reset-rpg-levelling-progress",
      name: "Reset RPG levelling progress",
      callback: async () => {
        this.data = Object.assign({}, DEFAULT_DATA, {
          lastKnownLengths: {},
          widgetPosition: this.getValidWidgetPosition(
            this.data.widgetPosition
          ),
        });
        await this.saveProgress();
        this.updateUi();
        new Notice("RPG levelling progress reset.");
      },
    });

    this.captureActiveFileLength();
  }

  onunload() {
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.lastAnimationTimer);
    if (this.hud) {
      this.hud.remove();
    }
    this.saveProgress();
  }

  async loadSavedProgress() {
    const pluginData = await this.loadData();
    const backupData = this.loadBackupProgress();

    if (this.hasProgress(pluginData)) {
      return pluginData;
    }

    if (this.hasProgress(backupData)) {
      await this.saveData(backupData);
      return backupData;
    }

    return pluginData || backupData || {};
  }

  loadBackupProgress() {
    try {
      const saved = window.localStorage.getItem(this.getBackupKey());
      return saved ? JSON.parse(saved) : null;
    } catch (error) {
      console.warn("RPG Levelling could not load backup progress.", error);
      return null;
    }
  }

  hasProgress(data) {
    return (
      data &&
      (Number(data.level) > 1 ||
        Number(data.xp) > 0 ||
        Number(data.typedCharacters) > 0)
    );
  }

  getBackupKey() {
    const vaultName = this.app.vault.getName
      ? this.app.vault.getName()
      : "default-vault";
    return `rpg-levelling:${vaultName}:progress`;
  }

  createStatusBar() {
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("rpg-levelling");

    this.levelLabel = this.statusBar.createSpan({
      cls: "rpg-levelling__level",
    });

    this.progressTrack = this.statusBar.createDiv({
      cls: "rpg-levelling__track",
    });

    this.progressFill = this.progressTrack.createDiv({
      cls: "rpg-levelling__fill",
    });

    this.progressText = this.statusBar.createSpan({
      cls: "rpg-levelling__text",
    });
  }

  createFloatingWidget() {
    this.hud = document.createElement("button");
    this.hud.type = "button";
    this.hud.className = "rpg-levelling-widget";
    document.body.appendChild(this.hud);
    this.applyWidgetPosition();

    this.hudLevelLabel = this.hud.createSpan({
      cls: "rpg-levelling-widget__level",
    });

    this.hudProgressTrack = this.hud.createDiv({
      cls: "rpg-levelling-widget__track",
    });

    this.hudProgressFill = this.hudProgressTrack.createDiv({
      cls: "rpg-levelling-widget__fill",
    });

    this.hudProgressText = this.hud.createSpan({
      cls: "rpg-levelling-widget__text",
    });

    this.hud.addEventListener("click", () => {
      this.showProgressNotice();
    });
  }

  moveWidgetToActivePane() {
    if (!this.hud) {
      return;
    }

    const leaf = this.app.workspace.activeLeaf;
    const view = leaf && leaf.view;
    const viewType = view && view.getViewType && view.getViewType();
    const nextHost =
      viewType === "markdown" && view.containerEl ? view.containerEl : null;

    if (!nextHost) {
      this.hud.addClass("rpg-levelling-widget--hidden");
      return;
    }

    if (this.widgetHost && this.widgetHost !== nextHost) {
      this.widgetHost.removeClass("rpg-levelling-widget-host");
    }

    this.widgetHost = nextHost;
    this.widgetHost.addClass("rpg-levelling-widget-host");

    if (this.hud.parentElement !== this.widgetHost) {
      this.widgetHost.appendChild(this.hud);
    }

    this.hud.removeClass("rpg-levelling-widget--hidden");
  }

  handleEditorChange(editor, info) {
    this.moveWidgetToActivePane();

    const fileKey = this.getFileKey(info);
    const currentLength = editor.getValue().length;
    const previousLength = this.data.lastKnownLengths[fileKey];

    this.data.lastKnownLengths[fileKey] = currentLength;

    if (typeof previousLength !== "number") {
      this.queueSave();
      return;
    }

    const gainedCharacters = Math.max(0, currentLength - previousLength);
    if (gainedCharacters === 0) {
      this.queueSave();
      return;
    }

    this.data.typedCharacters += gainedCharacters;
    this.addXp(gainedCharacters);
    this.updateUi();
    this.queueSave();
  }

  captureActiveFileLength() {
    const activeFile = this.app.workspace.getActiveFile();

    if (!activeFile) {
      return;
    }

    const editorInfo = this.app.workspace.activeEditor;
    const editor = editorInfo && editorInfo.editor;
    if (!editor) {
      return;
    }

    this.data.lastKnownLengths[activeFile.path] = editor.getValue().length;
    this.queueSave();
  }

  getFileKey(info) {
    if (info && info.file && info.file.path) {
      return info.file.path;
    }

    const activeFile = this.app.workspace.getActiveFile();
    return activeFile ? activeFile.path : "unknown-editor";
  }

  addXp(amount) {
    this.data.xp += amount;

    let leveledUp = false;
    while (this.data.xp >= this.xpForLevel(this.data.level)) {
      this.data.xp -= this.xpForLevel(this.data.level);
      this.data.level += 1;
      leveledUp = true;
    }

    if (leveledUp) {
      this.playLevelUpAnimation();
      new Notice(`Level up! You reached level ${this.data.level}.`);
    }
  }

  xpForLevel(level) {
    return Math.floor(80 + 35 * Math.pow(level, 1.65) + level * 18);
  }

  updateUi() {
    const needed = this.xpForLevel(this.data.level);
    const percent = Math.min(100, Math.max(0, (this.data.xp / needed) * 100));

    if (this.statusBar) {
      this.levelLabel.setText(`Lv ${this.data.level}`);
      this.progressFill.style.width = `${percent}%`;
      this.progressText.setText(`${this.data.xp}/${needed}`);
      this.statusBar.setAttribute(
        "aria-label",
        `RPG levelling: level ${this.data.level}, ${this.data.xp} of ${needed} XP`
      );
    }

    if (this.hud) {
      this.hudLevelLabel.setText(`Lv ${this.data.level}`);
      this.hudProgressFill.style.width = `${percent}%`;
      this.hudProgressText.setText(`${this.data.xp}/${needed} XP`);
      this.hud.title = `RPG Levelling: level ${this.data.level}, ${this.data.xp} of ${needed} XP`;
      this.hud.setAttribute(
        "aria-label",
        `RPG levelling: level ${this.data.level}, ${this.data.xp} of ${needed} XP`
      );
    }
  }

  applyWidgetPosition() {
    if (!this.hud) {
      return;
    }

    for (const position of WIDGET_POSITIONS) {
      this.hud.removeClass(`rpg-levelling-widget--${position.value}`);
    }

    this.hud.addClass(
      `rpg-levelling-widget--${this.getValidWidgetPosition(
        this.data.widgetPosition
      )}`
    );
  }

  getValidWidgetPosition(position) {
    return WIDGET_POSITIONS.some((option) => option.value === position)
      ? position
      : "bottom-right";
  }

  playLevelUpAnimation() {
    if (this.statusBar) {
      this.statusBar.removeClass("rpg-levelling--level-up");
      this.statusBar.offsetWidth;
      this.statusBar.addClass("rpg-levelling--level-up");
    }

    if (this.hud) {
      this.hud.removeClass("rpg-levelling-widget--level-up");
      this.hud.offsetWidth;
      this.hud.addClass("rpg-levelling-widget--level-up");
    }

    const burstHost = this.widgetHost || document.body;
    const burst = burstHost.createDiv({
      cls: "rpg-levelling-burst",
      text: `Level ${this.data.level}`,
    });

    window.clearTimeout(this.lastAnimationTimer);
    this.lastAnimationTimer = window.setTimeout(() => {
      if (this.statusBar) {
        this.statusBar.removeClass("rpg-levelling--level-up");
      }
      if (this.hud) {
        this.hud.removeClass("rpg-levelling-widget--level-up");
      }
      burst.remove();
    }, 1600);
  }

  showProgressNotice() {
    const needed = this.xpForLevel(this.data.level);
    new Notice(`Level ${this.data.level} - ${this.data.xp}/${needed} XP`);
  }

  queueSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveProgress();
    }, 700);
  }

  async saveProgress() {
    try {
      window.localStorage.setItem(this.getBackupKey(), JSON.stringify(this.data));
    } catch (error) {
      console.warn("RPG Levelling could not back up progress.", error);
    }

    await this.saveData(this.data);
  }
};

class RpgLevellingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "RPG Levelling" });

    new Setting(containerEl)
      .setName("Widget position")
      .setDesc("Choose where the XP widget appears inside the focused editor pane.")
      .addDropdown((dropdown) => {
        for (const position of WIDGET_POSITIONS) {
          dropdown.addOption(position.value, position.label);
        }

        dropdown
          .setValue(
            this.plugin.getValidWidgetPosition(this.plugin.data.widgetPosition)
          )
          .onChange(async (value) => {
            this.plugin.data.widgetPosition =
              this.plugin.getValidWidgetPosition(value);
            this.plugin.applyWidgetPosition();
            await this.plugin.saveProgress();
          });
      });
  }
}
