import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingTab,
	SuggestModal,
} from "obsidian";

import type { EditorPosition, MarkdownFileInfo, Menu, PluginManifest } from "obsidian";

import { DatamuseApi } from "./DatamuseApi";

interface WordyPluginSettings {
	toggleEditorMenu: boolean;
	toggleSynonymEditorMenu: boolean;
	toggleAntonymEditorMenu: boolean;
	toggleRhymeEditorMenu: boolean;
	toggleSuggestionsEditorMenu: boolean;
	editorMenuMaxResults: number;
	suggestionsMaxResults: number;
}

const DEFAULT_SETTINGS: WordyPluginSettings = {
	toggleEditorMenu: true,
	toggleSynonymEditorMenu: true,
	toggleAntonymEditorMenu: true,
	toggleRhymeEditorMenu: true,
	toggleSuggestionsEditorMenu: true,
	editorMenuMaxResults: 15,
	suggestionsMaxResults: 10
};

interface WordyResultCache {
	get(word: string[]): string[];
	set(word: string[], results: string[]): void;
}

class SimpleWordCache implements WordyResultCache {
	map: Map<string, string[]>;

	constructor() {
		this.map = new Map();
	}

	get(word: string[]): string[] {
		return this.map.get(word[0]) || [];
	}

	set(word: string[], results: string[]): void {
		this.map.set(word[0], results);
	}
}
// TODO: implement multi word keyed result caching

interface WordyCache {
	[key: string]: WordyResultCache;
}

const EMPTY_CACHE: WordyCache = {
	syn: new SimpleWordCache(),
	ant: new SimpleWordCache(),
	rhy: new SimpleWordCache(),
};

export default class WordyPlugin extends Plugin {
	settings: WordyPluginSettings = DEFAULT_SETTINGS;
	datamuseApi: DatamuseApi;
	caches: WordyCache = EMPTY_CACHE;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.datamuseApi = new DatamuseApi();
	}

	async onload() {
		await this.loadSettings();

		// Right click menus
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				if (!this.settings.toggleEditorMenu) {
					return;
				}

				if (this.settings.toggleSynonymEditorMenu) {
					menu.addItem((item) => {
						item.setTitle('Synonyms')
							.setIcon('book-plus');

						const submenu = item.setSubmenu();
						this.createWordMenu(submenu, editor, this.processSynonyms.bind(this));
					});
				}

				if (this.settings.toggleAntonymEditorMenu) {
					menu.addItem((item) => {
						item.setTitle('Antonyms')
							.setIcon('book-minus');

						const submenu = item.setSubmenu();
						this.createWordMenu(submenu, editor, this.processAntonyms.bind(this));
					});
				}

				if (this.settings.toggleRhymeEditorMenu) {
					menu.addItem((item) => {
						item.setTitle('Rhymes')
							.setIcon('book-headphones');

						const submenu = item.setSubmenu();
						this.createWordMenu(submenu, editor, this.processRhymes.bind(this));
					});
				}
			})
		);

		this.registerView(
			VIEW_ID,
			(leaf) => new WordyView(leaf)
		);
		this.addRibbonIcon("pilcrow", "Wordy view", () => {
			this.activateView();
		});

		this.addCommand({
			id: "wordy-syn",
			name: "Synonyms",
			editorCallback: async (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				this.createCommandModal(editor, this.processSynonyms.bind(this));
			},
		});

		this.addCommand({
			id: "wordy-ant",
			name: "Antonyms",
			editorCallback: async (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				this.createCommandModal(editor, this.processAntonyms.bind(this));
			},
		});

		this.addCommand({
			id: "wordy-rhy",
			name: "Rhymes",
			editorCallback: async (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				this.createCommandModal(editor, this.processRhymes.bind(this));
			},
		});

		this.addCommand({
			id: "wordy-asyn",
			name: "Alliterative Synonyms",
			editorCallback: async (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const [priorWord, rootWord] = editor.getSelection().split(" ");
				if (rootWord != "") {
					const alliterativeSynonyms =
						await this.datamuseApi.alliterativeSynonyms(
							priorWord,
							rootWord
						);
					if (alliterativeSynonyms.length == 0) {
						new Notice(`Oops — No rhymes found.`);
						return;
					}
					new SearchableWordsModal(
						this.app,
						alliterativeSynonyms,
						(selectedWord: string) => {
							editor.replaceSelection(`${selectedWord}`);
						}
					).open();
				} else {
					new Notice(`Oops — Select a word first.`);
				}
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new WordyPluginSettingTab(this.app, this));
	}

	async processSynonyms(word: string): Promise<string[]> {
		return this.getCacheOrFetch(this.caches["syn"], word, (word: string) => {
			return this.datamuseApi.wordsSimilarTo(word);
		});
	}

	async processAntonyms(word: string): Promise<string[]> {
		return this.getCacheOrFetch(this.caches["ant"], word, (word: string) => {
			return this.datamuseApi.wordsOppositeTo(word, true);
		});
	}

	async processRhymes(word: string): Promise<string[]> {
		return this.getCacheOrFetch(this.caches["rhy"], word, (word: string) => {
			return this.datamuseApi.wordsThatRhymeWith(word);
		});
	}

	async getCacheOrFetch(cache: WordyResultCache, word: string, fetchFn: (word: string) => Promise<string[]>) {
		const cached = cache.get([word]);
		if (cached.length > 0) {
			return cached;
		}

		const results = await fetchFn(word);
		cache.set([word], results);
		return results;
	}

	getSentenceUnderCursor(editor: Editor, from: EditorPosition, to: EditorPosition) {
		const line = editor.getLine(from.line);
		const sentenceEndings = ['.', '!', '?'];

		function findWordBoundaries(text: string, start: number, direction: number) {
			let count = 0;
			let index = start;

			while (count < 5 && index >= 0 && index < text.length) {
				if (sentenceEndings.includes(text[index])) {
					return index;
				}
				if (/\s/.test(text[index])) {
					count++;
				}
				index += direction;
			}

			return direction === -1 ? index + 1 : index;
		}

		// Move backward 5 words
		const start = findWordBoundaries(line, from.ch, -1);

		// Move forward 5 words
		const end = findWordBoundaries(line, to.ch, 1);

		// Extract the sentence
		const regex = /^[.!?\s]+|[.!?\s]+$/g;
		const sentence = line.substring(start, end).replace(regex, '');
		return sentence;
	}

	getRootSelection(editor: Editor) {
		const selection = editor.getSelection();
		if (selection) {
			const from = editor.getCursor("from");
			const to = editor.getCursor("to");
			const sentence = this.getSentenceUnderCursor(editor, from, to);
			return { word: selection, from: from, to: to, sentence: sentence };
		}

		const cursorWordAt = editor.wordAt(editor.getCursor());
		if (!cursorWordAt) {
			return { word: "", from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, sentence: "" };
		}

		const sFrom = cursorWordAt.from;
		const sTo = cursorWordAt.to;
		const sWord = editor.getRange(sFrom, sTo);
		const sSentence = this.getSentenceUnderCursor(editor, sFrom, sTo);
		return { word: sWord, from: sFrom, to: sTo, sentence: sSentence };
	}

	async createCommandModal(editor: Editor, processWord: (word: string) => Promise<string[]>) {
		const { word, from, to } = this.getRootSelection(editor);
		const results = await processWord(word);
		if (results.length == 0) {
			new Notice(`Oops — No results found.`);
			return;
		}
		new SearchableWordsModal(
			this.app,
			results,
			(selectedWord: string) => {
				editor.replaceRange(selectedWord, from, to);
			}
		).open();
	}

	async createWordMenu(menu: Menu, editor: Editor, processWord: (word: string, sentence: string) => Promise<string[]>) {
		const { word, from, to, sentence } = this.getRootSelection(editor);
		const results = await processWord(word, sentence);
		this.createMenuForWords(menu, results, editor, from, to);
	}

	createMenuForWords(menu: Menu, words: string[], editor: Editor, from: EditorPosition, to: EditorPosition) {
		if (words.length == 0) {
			menu.addItem((item) => {
				item.setTitle("No results found.");
			});
		}

		words.slice(0, this.settings.editorMenuMaxResults).forEach((word) => {
			menu.addItem((item) => {
				item.setTitle(word)
					.onClick(() => {
						editor.replaceRange(word, from, to);
					});
			});
		});

		// Add option to use modal if there are more than the max results in right click menu
		if (words.length > this.settings.editorMenuMaxResults) {
			menu.addSeparator();
			menu.addItem((item) => {
				item.setTitle(`More... (${words.length - this.settings.editorMenuMaxResults})`)
					.onClick(() => {
						new SearchableWordsModal(
							this.app,
							words,
							(selectedWord: string) => {
								editor.replaceRange(selectedWord, from, to);
							}
						).open();
					});
			});
		}
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(VIEW_ID);

		await this.app.workspace.getRightLeaf(false).setViewState({
			type: VIEW_ID,
			active: true,
		});

		this.app.workspace.revealLeaf(
			this.app.workspace.getLeavesOfType(VIEW_ID)[0]
		);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// Wordy View
import { ItemView, WorkspaceLeaf } from "obsidian";
import Component from "./Component.svelte";

export const VIEW_ID = "wordy-view";

export class WordyView extends ItemView {
	component: Component;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_ID;
	}

	getDisplayText() {
		return "Wordy";
	}

	async onOpen() {
		// const container = this.containerEl.children[1];
		// container.empty();
		// container.createEl("h4", { text: "Wordy" });
		// debugger;
		this.component = new Component({
			target: this.containerEl.children[1],
			props: {
				variable: 42
			}
		})
	}

	async onClose() {
		// Kill the svelte app
		this.component.$destroy();
	}
}

// Suggestion modal
type Word = string;
export class SearchableWordsModal extends SuggestModal<Word> {
	words: string[];
	replaceFn: any;

	constructor(app: App, words: string[], replaceFn: any) {
		super(app);
		this.words = words;
		this.replaceFn = replaceFn;
		if (words.length == 0) {
			return;
		}
	}

	// Returns all available suggestions.
	getSuggestions(query: string): Word[] {
		return this.words.filter((word: string) =>
			word.toLowerCase().includes(query.toLowerCase())
		);
	}

	// Renders each suggestion item.
	renderSuggestion(word: Word, el: HTMLElement) {
		el.createEl("div", { text: word });
	}

	// Perform action on the selected suggestion.
	onChooseSuggestion(word: Word, evt: MouseEvent | KeyboardEvent) {
		this.replaceFn(word);
	}
}

/**
 * Setting Pane
 */

class WordyPluginSettingTab extends PluginSettingTab {
	plugin: WordyPlugin;

	constructor(app: App, plugin: WordyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Settings" });

		containerEl.createEl("h3", { text: "Editor Menu" });

		// Toggle for editor menu
		new Setting(containerEl)
			.setName("Toggle for editor menu")
			.setDesc("Enable or disable the editor menu.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.toggleEditorMenu)
					.onChange(async (value) => {
						this.plugin.settings.toggleEditorMenu = value;
						await this.plugin.saveSettings();
					})
			);

		// Toggle for synonym editor menu
		new Setting(containerEl)
			.setName("Toggle for synonym editor menu")
			.setDesc("Enable or disable the synonym editor menu.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.toggleSynonymEditorMenu)
					.onChange(async (value) => {
						this.plugin.settings.toggleSynonymEditorMenu = value;
						await this.plugin.saveSettings();
					})
			);

		// Toggle for antonym editor menu
		new Setting(containerEl)
			.setName("Toggle for antonym editor menu")
			.setDesc("Enable or disable the antonym editor menu.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.toggleAntonymEditorMenu)
					.onChange(async (value) => {
						this.plugin.settings.toggleAntonymEditorMenu = value;
						await this.plugin.saveSettings();
					})
			);

		// Toggle for rhyme editor menu
		new Setting(containerEl)
			.setName("Toggle for rhyme editor menu")
			.setDesc("Enable or disable the rhyme editor menu.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.toggleRhymeEditorMenu)
					.onChange(async (value) => {
						this.plugin.settings.toggleRhymeEditorMenu = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max results")
			.setDesc("Maximum number of results to show in the editor menu.")
			.setDisabled(!this.plugin.settings.toggleEditorMenu)
			.addText((text) =>
				text.setValue(this.plugin.settings.editorMenuMaxResults.toString())
					.onChange(async (value) => {
						this.plugin.settings.editorMenuMaxResults = parseInt(value);
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Advanced" });

		// Clear cache
		new Setting(containerEl)
			.setName("Clear cache")
			.setDesc("Clear the web results cache.")
			.addButton((button) =>
				button.setButtonText("Clear cache")
					.onClick(async () => {
						this.plugin.caches = EMPTY_CACHE;
						new Notice("Cache cleared.");
					})
			);

	}
}
