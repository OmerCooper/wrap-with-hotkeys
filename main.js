const { Plugin, PluginSettingTab, Setting, Modal, Notice, Platform } = require("obsidian");

const DEFAULT_SETTINGS = {
	wrappers: [{ id: "underline", name: "Underline", startTag: "<u>", endTag: "</u>" }],
};
const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta"];
const OLD_PLUGIN_ID = "obsidian-wrap-with-shortcuts";

// ---------- hotkey helpers (Obsidian's format: { modifiers: ["Mod", "Shift"], key: "U" }) ----------

function hotkeyFromEvent(e) {
	if (MODIFIER_KEYS.includes(e.key)) return null;
	let key;
	if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
	else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
	else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
	const modifiers = [];
	// "Mod" is Ctrl on Windows/Linux and Cmd on macOS, like Obsidian's own hotkeys
	if (Platform.isMacOS ? e.metaKey : e.ctrlKey) modifiers.push("Mod");
	if (Platform.isMacOS && e.ctrlKey) modifiers.push("Ctrl");
	if (!Platform.isMacOS && e.metaKey) modifiers.push("Meta");
	if (e.altKey) modifiers.push("Alt");
	if (e.shiftKey) modifiers.push("Shift");
	return { modifiers, key };
}

function hotkeyToString(hk) {
	if (!hk) return "";
	const names = Platform.isMacOS
		? { Mod: "Cmd", Ctrl: "Ctrl", Meta: "Cmd", Alt: "Option", Shift: "Shift" }
		: { Mod: "Ctrl", Ctrl: "Ctrl", Meta: "Win", Alt: "Alt", Shift: "Shift" };
	return [...hk.modifiers.map((m) => names[m] || m), hk.key].join("+");
}

function sameHotkey(a, b) {
	if (!a || !b || a.key.toLowerCase() !== b.key.toLowerCase()) return false;
	const sa = [...a.modifiers].sort().join(",");
	const sb = [...b.modifiers].sort().join(",");
	return sa === sb;
}

module.exports = class WrapWithHotkeysPlugin extends Plugin {
	async onload() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.registeredIds = new Set();
		for (const w of this.settings.wrappers) this.registerWrapperCommand(w);
		this.addSettingTab(new WrapSettingTab(this.app, this));
		// First run: take over the wrappers (and their hotkeys) from "Wrap with shortcuts" if it is installed
		if (!saved) this.app.workspace.onLayoutReady(() => this.importFromOldPlugin());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	commandId(wrapper) {
		return `wrap-${wrapper.id}`;
	}

	fullCommandId(wrapper) {
		return `${this.manifest.id}:${this.commandId(wrapper)}`;
	}

	// Commands are added and removed live, so no restart is needed
	registerWrapperCommand(wrapper) {
		const id = this.commandId(wrapper);
		if (this.registeredIds.has(id)) this.unregisterWrapperCommand(wrapper);
		this.addCommand({
			id,
			name: `Toggle ${wrapper.name}`,
			editorCallback: (editor) => {
				// Look the wrapper up at call time so edits to its tags apply right away
				const current = this.settings.wrappers.find((w) => w.id === wrapper.id);
				if (current) this.wrapSelection(editor, current.startTag, current.endTag);
			},
		});
		this.registeredIds.add(id);
	}

	unregisterWrapperCommand(wrapper) {
		const id = this.commandId(wrapper);
		if (typeof this.removeCommand === "function") this.removeCommand(id);
		else this.app.commands.removeCommand(`${this.manifest.id}:${id}`);
		this.registeredIds.delete(id);
	}

	// ---------- hotkeys, stored in Obsidian's hotkey manager so they show in Settings > Hotkeys ----------

	get hotkeyManager() {
		return this.app.hotkeyManager;
	}

	getHotkey(wrapper) {
		const hm = this.hotkeyManager;
		if (!hm) return null;
		const id = this.fullCommandId(wrapper);
		const keys = (hm.customKeys && hm.customKeys[id]) || (hm.getHotkeys && hm.getHotkeys(id)) || [];
		return keys[0] || null;
	}

	async setHotkey(wrapper, hotkey) {
		const hm = this.hotkeyManager;
		if (!hm) {
			new Notice("Could not reach Obsidian's hotkey settings; set it in Settings > Hotkeys.");
			return;
		}
		const id = this.fullCommandId(wrapper);
		hm.setHotkeys(id, hotkey ? [hotkey] : []);
		if (typeof hm.bake === "function") hm.bake();
		if (typeof hm.save === "function") await hm.save();
	}

	async clearHotkeyRecord(wrapper) {
		const hm = this.hotkeyManager;
		if (!hm) return;
		if (typeof hm.removeHotkeys === "function") hm.removeHotkeys(this.fullCommandId(wrapper));
		else delete hm.customKeys[this.fullCommandId(wrapper)];
		if (typeof hm.bake === "function") hm.bake();
		if (typeof hm.save === "function") await hm.save();
	}

	// Names of other commands that already use this hotkey
	findHotkeyConflicts(hotkey, exceptCommandId) {
		const hm = this.hotkeyManager;
		if (!hm || !hotkey) return [];
		const conflicts = [];
		const commands = this.app.commands.commands || {};
		for (const id of Object.keys(commands)) {
			if (id === exceptCommandId) continue;
			const keys = (hm.customKeys && hm.customKeys[id]) || (hm.defaultKeys && hm.defaultKeys[id]) || [];
			if (keys.some((k) => sameHotkey(k, hotkey))) conflicts.push(commands[id].name);
		}
		return conflicts;
	}

	// ---------- wrappers ----------

	async saveWrapper(wrapper, hotkey) {
		const list = this.settings.wrappers;
		const index = list.findIndex((w) => w.id === wrapper.id);
		if (index === -1) list.push(wrapper);
		else list[index] = wrapper;
		list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		await this.saveSettings();
		this.registerWrapperCommand(wrapper);
		await this.setHotkey(wrapper, hotkey);
	}

	async deleteWrapper(wrapper) {
		this.settings.wrappers = this.settings.wrappers.filter((w) => w.id !== wrapper.id);
		await this.saveSettings();
		this.unregisterWrapperCommand(wrapper);
		await this.clearHotkeyRecord(wrapper);
	}

	async importFromOldPlugin() {
		try {
			const path = `${this.app.vault.configDir}/plugins/${OLD_PLUGIN_ID}/data.json`;
			if (!(await this.app.vault.adapter.exists(path))) return;
			const old = JSON.parse(await this.app.vault.adapter.read(path));
			const tags = (old && old.wrapperTags) || [];
			if (!tags.length) return;
			const hm = this.hotkeyManager;
			for (const w of this.settings.wrappers) this.unregisterWrapperCommand(w);
			this.settings.wrappers = [];
			for (const t of tags) {
				const wrapper = { id: String(t.id || Date.now()), name: t.name || "Wrapper", startTag: t.startTag || "", endTag: t.endTag || "" };
				const oldKeys = hm && hm.customKeys && hm.customKeys[`${OLD_PLUGIN_ID}:wrap-with-shortcut-${t.id}`];
				await this.saveWrapper(wrapper, oldKeys && oldKeys[0]);
			}
			new Notice(`Wrap with hotkeys: imported ${tags.length} wrapper(s) from "Wrap with shortcuts".`);
		} catch (e) {
			console.error("Wrap with hotkeys: import failed", e);
		}
	}

	// Wraps the selection, or unwraps it if the tags are already around or inside it
	wrapSelection(editor, startTag, endTag) {
		if (!startTag && !endTag) return;
		const selected = editor.getSelection();
		const pos = (o) => editor.offsetToPos(o);
		const range = (a, b) => {
			try {
				return a < 0 ? "" : editor.getRange(pos(a), pos(b));
			} catch (_) {
				return "";
			}
		};
		const from = editor.posToOffset(editor.getCursor("from"));
		const to = editor.posToOffset(editor.getCursor("to"));
		const sl = startTag.length;
		const el = endTag.length;

		if (range(from - sl, from) === startTag && range(to, to + el) === endTag) {
			// Tags just outside the selection: remove them
			editor.replaceRange(selected, pos(from - sl), pos(to + el));
			editor.setSelection(pos(from - sl), pos(to - sl));
		} else if (to - from >= sl + el && range(from, from + sl) === startTag && range(to - el, to) === endTag) {
			// Tags at the edges of the selection: remove them
			editor.replaceSelection(selected.slice(sl, selected.length - el));
			editor.setSelection(pos(from), pos(to - sl - el));
		} else {
			editor.replaceSelection(`${startTag}${selected}${endTag}`);
			editor.setSelection(pos(from + sl), pos(to + sl));
		}
	}
};

// ---------- add / edit dialog ----------

class WrapperModal extends Modal {
	constructor(plugin, wrapper, onDone) {
		super(plugin.app);
		this.plugin = plugin;
		this.onDone = onDone;
		this.editMode = !!wrapper;
		this.wrapper = wrapper ? { ...wrapper } : { id: `w${Date.now()}`, name: "", startTag: "", endTag: "" };
		this.hotkey = wrapper ? plugin.getHotkey(wrapper) : null;
		this.stopCapture = null;
	}

	onOpen() {
		this.titleEl.setText(this.editMode ? "Edit wrapper" : "Add a new wrapper");
		this.draw();
	}

	onClose() {
		if (this.stopCapture) this.stopCapture();
		this.contentEl.empty();
	}

	draw() {
		const el = this.contentEl;
		el.empty();

		new Setting(el).setName("Name").setDesc("Shown in the command palette as \"Toggle <name>\".").addText((t) =>
			t
				.setPlaceholder("e.g. Underline")
				.setValue(this.wrapper.name)
				.onChange((v) => {
					this.wrapper.name = v.trim();
					this.updatePreview();
				})
		);
		new Setting(el).setName("Start tag").addTextArea((t) =>
			t
				.setPlaceholder("<u>")
				.setValue(this.wrapper.startTag)
				.onChange((v) => {
					this.wrapper.startTag = v;
					this.updatePreview();
				})
		);
		new Setting(el).setName("End tag").addTextArea((t) =>
			t
				.setPlaceholder("</u>")
				.setValue(this.wrapper.endTag)
				.onChange((v) => {
					this.wrapper.endTag = v;
					this.updatePreview();
				})
		);

		const hotkeySetting = new Setting(el)
			.setName("Hotkey")
			.setDesc("Click the button, then press a key combination. Esc cancels, Backspace removes.")
			.addButton((b) => {
				b.buttonEl.addClass("wwh-hotkey-button");
				b.setButtonText(hotkeyToString(this.hotkey) || "No hotkey").onClick(() => this.captureHotkey(b));
			});
		if (this.hotkey) {
			hotkeySetting.addExtraButton((b) =>
				b
					.setIcon("x")
					.setTooltip("Remove hotkey")
					.onClick(() => {
						this.hotkey = null;
						this.draw();
					})
			);
		}
		const conflicts = this.plugin.findHotkeyConflicts(this.hotkey, this.plugin.fullCommandId(this.wrapper));
		if (conflicts.length) {
			el.createDiv({
				cls: "wwh-warning",
				text: `${hotkeyToString(this.hotkey)} is also used by: ${conflicts.join(", ")}`,
			});
		}

		this.previewEl = el.createDiv({ cls: "wwh-preview" });
		this.updatePreview();

		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.saveBtn = b;
				b.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						if (!this.isValid()) return;
						await this.plugin.saveWrapper(this.wrapper, this.hotkey);
						this.close();
						this.onDone();
					});
			});
		this.updatePreview();
	}

	isValid() {
		return this.wrapper.name !== "" && (this.wrapper.startTag !== "" || this.wrapper.endTag !== "");
	}

	updatePreview() {
		if (this.previewEl) this.previewEl.setText(`${this.wrapper.startTag}selected text${this.wrapper.endTag}`);
		if (this.saveBtn) this.saveBtn.setDisabled(!this.isValid());
	}

	captureHotkey(btn) {
		if (this.stopCapture) return;
		btn.setButtonText("Press keys...");
		const win = btn.buttonEl.win || window;
		const onKey = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") return finish();
			if (e.key === "Backspace" || e.key === "Delete") {
				this.hotkey = null;
				return finish();
			}
			const hk = hotkeyFromEvent(e);
			if (!hk) return; // wait for a non-modifier key
			this.hotkey = hk;
			finish();
		};
		const stop = () => {
			win.removeEventListener("keydown", onKey, true);
			this.stopCapture = null;
		};
		const finish = () => {
			stop();
			this.draw();
		};
		this.stopCapture = stop;
		win.addEventListener("keydown", onKey, true);
	}
}

// ---------- settings tab ----------

class WrapSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Add a new wrapper")
			.setDesc("Wraps the selected text in your tags. Press the hotkey again to unwrap.")
			.addButton((b) =>
				b
					.setIcon("plus")
					.setCta()
					.setTooltip("Add wrapper")
					.onClick(() => new WrapperModal(this.plugin, null, () => this.display()).open())
			);

		for (const wrapper of this.plugin.settings.wrappers) {
			const hk = hotkeyToString(this.plugin.getHotkey(wrapper));
			const s = new Setting(containerEl)
				.setName(wrapper.name)
				.setDesc(`${wrapper.startTag}{selected text}${wrapper.endTag}`);
			s.controlEl.createSpan({ cls: "wwh-hotkey-label", text: hk || "No hotkey" });
			s.addExtraButton((b) =>
				b
					.setIcon("pencil")
					.setTooltip("Edit")
					.onClick(() => new WrapperModal(this.plugin, wrapper, () => this.display()).open())
			).addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Delete")
					.onClick(async () => {
						await this.plugin.deleteWrapper(wrapper);
						this.display();
					})
			);
		}
	}
}
