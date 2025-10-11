/**
 * Site Metadata - Main Plugin Logic
 * Learns metadata patterns from existing items and auto-fills new entries
 */

Zotero.SiteMetadata = {
	id: null,
	version: null,
	rootURI: null,
	addedElementIDs: [],
	presets: {},
	blocklist: null,
	notifierID: null,

	// Configuration
	CONFIG: {
		FIELDS_TO_INFER: [
			'itemType',
			'creators',
			'blogTitle',
			'publicationTitle',
			'websiteTitle',
			'websiteType',
			'language'
		],
		MIN_ITEMS_PER_DOMAIN: 1,
		STORAGE_KEY: 'extensions.sitemetadata.presets'
	},

	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;

		this.log("Initializing Site Metadata plugin");

		await this.loadPresets();

		// Build blocklist from translators
		this.blocklist = await this.getTranslatorDomains();
		this.log(`Blocklist contains ${this.blocklist.size} domains`);

		// Register item notifier for auto-update and auto-fill
		this.registerNotifier();

		await this.updatePresets();
	},

	log: (msg) => Zotero.debug(`Site Metadata: ${msg}`),

	async addToWindow(window) {
		// Add menu items or UI elements if needed
		this.log("Adding to window");
	},

	async addToAllWindows() {
		const windows = Zotero.getMainWindows();
		await Promise.all(windows.map(window => this.addToWindow(window)));
	},

	removeFromWindow: (window) => {
		Zotero.SiteMetadata.log("Removing from window");
	},

	removeFromAllWindows() {
		Zotero.getMainWindows().forEach(window => this.removeFromWindow(window));

		this.notifierID && Zotero.Notifier.unregisterObserver(this.notifierID);
	},

	// ===== PRESET STORAGE =====

	async loadPresets() {
		try {
			const stored = Zotero.Prefs.get(this.CONFIG.STORAGE_KEY);
			if (stored) {
				this.presets = JSON.parse(stored);
				this.log(`Loaded ${Object.keys(this.presets).length} presets from storage`);
			}
		} catch (error) {
			this.log(`Error loading presets: ${error}`);
		}
	},

	async savePresets() {
		try {
			Zotero.Prefs.set(this.CONFIG.STORAGE_KEY, JSON.stringify(this.presets));
			this.log(`Saved ${Object.keys(this.presets).length} presets to storage`);
		} catch (error) {
			this.log(`Error saving presets: ${error}`);
		}
	},

	// ===== NOTIFIER FOR AUTO-UPDATE AND AUTO-FILL =====

	registerNotifier() {
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: async (event, type, ids) => {
				if (type !== 'item' || !['add', 'modify'].includes(event)) return;

				for (const id of ids) {
					try {
						const item = await Zotero.Items.getAsync(id);

						// Auto-fill for new items
						event === 'add' && await Zotero.SiteMetadata.autoFillItem(item);

						// Auto-update presets when items change
						const url = item.getField('url');
						if (url) {
							const domain = Zotero.SiteMetadata.getDomain(url);
							domain && !Zotero.SiteMetadata.blocklist.has(domain) &&
								await Zotero.SiteMetadata.updatePresetsForDomain(domain);
						}
					} catch (error) {
						Zotero.SiteMetadata.log(`Error processing item ${id}: ${error}`);
					}
				}
			}
		}, ['item']);
	},

	// ===== DOMAIN EXTRACTION =====

	async getTranslatorDomains() {
		const translators = await Zotero.Translators.getAll();
		const webTranslators = translators.filter(t => t.translatorType & 4);

		const domains = new Set();

		const patterns = [
			/(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi,
			/(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/gi,
			/([a-z0-9-]+\\\.(?:[a-z0-9-]+\\\.)*[a-z]{2,})/gi
		];

		const invalidChars = ['[', '(', '*', '?', '^', '$'];
		const isValidDomain = (domain) =>
			domain &&
			!invalidChars.some(char => domain.includes(char)) &&
			domain.split('.').length >= 2 &&
			domain.length < 100;

		for (const translator of webTranslators) {
			if (!translator.target) continue;

			for (const pattern of patterns) {
				const regex = new RegExp(pattern.source, pattern.flags);
				let match;
				while ((match = regex.exec(translator.target)) !== null) {
					const domain = match[1]
						.replace(/\\\./g, '.')
						.replace(/^www\./, '')
						.toLowerCase();

					isValidDomain(domain) && domains.add(domain);
				}
			}
		}

		return domains;
	},

	getDomain: (url) => {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return null;
		}
	},

	// ===== ITEM VALIDATION =====

	shouldSkipItem(item) {
		const EXCLUDED_CATALOGS = new Set(['Embedded Metadata', 'Web Page', 'ZoteroSnapshot', '']);

		if (!item.isRegularItem() || item.deleted || item.isAttachment()) {
			return { skip: true, reason: 'not regular item' };
		}

		const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
		if (!['webpage', 'blogPost'].includes(itemType)) {
			return { skip: true, reason: `itemType: ${itemType}` };
		}

		const identifiers = ['DOI', 'ISBN', 'ISSN'];
		if (identifiers.some(id => item.getField(id))) {
			return { skip: true, reason: 'has identifier (DOI/ISBN/ISSN)' };
		}

		const libraryCatalog = item.getField('libraryCatalog');
		if (libraryCatalog && !EXCLUDED_CATALOGS.has(libraryCatalog)) {
			return { skip: true, reason: `libraryCatalog: ${libraryCatalog}` };
		}

		const url = item.getField('url');
		if (!url) {
			return { skip: true, reason: 'no URL' };
		}

		const domain = this.getDomain(url);
		if (!domain) {
			return { skip: true, reason: 'invalid URL' };
		}

		if (this.blocklist.has(domain)) {
			return { skip: true, reason: `blocklisted (has translator): ${domain}` };
		}

		return { skip: false, domain };
	},

	// ===== FIELD HANDLING =====

	hasFieldValue(item, fieldName) {
		if (fieldName === 'creators') {
			return item.getCreators().some(c =>
				Zotero.CreatorTypes.getName(c.creatorTypeID) === 'author'
			);
		}

		if (fieldName === 'itemType') return true;

		try {
			const value = item.getField(fieldName);
			return Boolean(value?.trim());
		} catch {
			return false;
		}
	},

	getFieldValue(item, fieldName) {
		if (fieldName === 'creators') {
			return item.getCreators()
				.filter(c => Zotero.CreatorTypes.getName(c.creatorTypeID) === 'author')
				.map(c => ({
					firstName: c.firstName ?? '',
					lastName: c.lastName ?? c.name ?? '',
					creatorType: 'author'
				}));
		}

		if (fieldName === 'itemType') {
			return Zotero.ItemTypes.getName(item.itemTypeID);
		}

		try {
			return item.getField(fieldName) || null;
		} catch {
			return null;
		}
	},

	getItemMetadata: (item) => ({
		item,
		lastTouched: item.dateModified > item.dateAdded ? item.dateModified : item.dateAdded,
		title: item.getField('title') || null
	}),

	// ===== PRESET GENERATION (Majority Voting) =====

	generatePresetForDomain(items, domain) {
		items.sort((a, b) => new Date(b.lastTouched) - new Date(a.lastTouched));

		const preset = {};
		const fieldSources = {};

		// For each field, use majority voting
		for (const fieldName of this.CONFIG.FIELDS_TO_INFER) {
			const valueCounts = new Map();

			for (const itemMeta of items) {
				if (!this.hasFieldValue(itemMeta.item, fieldName)) continue;

				const fieldValue = this.getFieldValue(itemMeta.item, fieldName);
				const serializedValue = JSON.stringify(fieldValue);

				if (!valueCounts.has(serializedValue)) {
					valueCounts.set(serializedValue, {
						count: 0,
						mostRecentItem: itemMeta,
						actualValue: fieldValue
					});
				}

				const entry = valueCounts.get(serializedValue);
				entry.count++;

				if (new Date(itemMeta.lastTouched) > new Date(entry.mostRecentItem.lastTouched)) {
					entry.mostRecentItem = itemMeta;
				}
			}

			if (valueCounts.size === 0) continue;

			let selectedEntry = null;
			let maxCount = 0;

			for (const [, entry] of valueCounts) {
				const shouldSelect = entry.count > maxCount ||
					(entry.count === maxCount && selectedEntry &&
					 new Date(entry.mostRecentItem.lastTouched) > new Date(selectedEntry.mostRecentItem.lastTouched));

				if (shouldSelect) {
					maxCount = entry.count;
					selectedEntry = entry;
				}
			}

			if (!selectedEntry) continue;

			const fieldValue = selectedEntry.actualValue;

			if (fieldName === 'creators' && fieldValue.length === 0) continue;

			preset[fieldName] = fieldValue;

			const totalItemsWithField = Array.from(valueCounts.values())
				.reduce((sum, e) => sum + e.count, 0);

			fieldSources[fieldName] = {
				lastTouched: selectedEntry.mostRecentItem.lastTouched,
				title: selectedEntry.mostRecentItem.title,
				voteCount: selectedEntry.count,
				totalItemsWithField,
				uniqueValues: valueCounts.size
			};
		}

		if (Object.keys(preset).length === 0) return null;

		return {
			...preset,
			_stats: {
				totalItemsFromDomain: items.length,
				mostRecentItemDate: items[0].lastTouched,
				fieldSources
			}
		};
	},

	// ===== PRESET UPDATES =====

	async updatePresets() {
		this.log("Updating all presets...");

		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		const itemIDs = await search.search();

		// Group items by domain
		const domainMap = new Map();

		for (const id of itemIDs) {
			const item = await Zotero.Items.getAsync(id);
			const result = this.shouldSkipItem(item);

			if (result.skip) continue;

			const { domain } = result;
			if (!domainMap.has(domain)) {
				domainMap.set(domain, []);
			}

			domainMap.get(domain).push(this.getItemMetadata(item));
		}

		this.presets = Object.fromEntries(
			Array.from(domainMap.entries())
				.filter(([, items]) => items.length >= this.CONFIG.MIN_ITEMS_PER_DOMAIN)
				.map(([domain, items]) => [domain, this.generatePresetForDomain(items, domain)])
				.filter(([, preset]) => preset)
		);

		await this.savePresets();
		this.log(`Updated ${Object.keys(this.presets).length} presets`);
	},

	async updatePresetsForDomain(domain) {
		this.log(`Updating preset for domain: ${domain}`);

		const search = new Zotero.Search();
		search.libraryID = Zotero.Libraries.userLibraryID;
		const itemIDs = await search.search();

		const items = [];
		for (const id of itemIDs) {
			const item = await Zotero.Items.getAsync(id);
			const result = this.shouldSkipItem(item);

			if (result.skip || result.domain !== domain) continue;

			items.push(this.getItemMetadata(item));
		}

		if (items.length >= this.CONFIG.MIN_ITEMS_PER_DOMAIN) {
			const preset = this.generatePresetForDomain(items, domain);
			if (preset) {
				this.presets[domain] = preset;
				await this.savePresets();
				this.log(`Updated preset for ${domain} (${items.length} items)`);
			}
		}
	},

	// ===== AUTO-FILL FUNCTIONALITY =====

	async autoFillItem(item) {
		const result = this.shouldSkipItem(item);
		if (result.skip) return;

		const { domain } = result;
		const preset = this.presets[domain];

		if (!preset) {
			this.log(`No preset found for domain: ${domain}`);
			return;
		}

		this.log(`Auto-filling item from ${domain}`);
		let modified = false;

		// Apply itemType first if it needs to change
		if (preset.itemType) {
			const currentItemType = Zotero.ItemTypes.getName(item.itemTypeID);
			const { itemType: presetItemType } = preset;

			if (currentItemType !== presetItemType) {
				try {
					const newTypeID = Zotero.ItemTypes.getID(presetItemType);
					if (newTypeID) {
						item.setType(newTypeID);
						modified = true;
						this.log(`  Changed item type: ${currentItemType} → ${presetItemType}`);
					}
				} catch (error) {
					this.log(`  Error changing item type: ${error}`);
				}
			}
		}

		// Apply other preset fields (excluding stats and itemType)
		for (const [fieldName, value] of Object.entries(preset)) {
			if (['_stats', 'itemType'].includes(fieldName)) continue;

			try {
				// Only fill if field is empty
				if (!this.hasFieldValue(item, fieldName)) {
					if (fieldName === 'creators') {
						value.forEach((creator, index) => {
							item.setCreator(item.getCreators().length, creator,
								Zotero.CreatorTypes.getID(creator.creatorType));
						});
					} else {
						item.setField(fieldName, value);
					}
					modified = true;
					this.log(`  Filled ${fieldName}: ${JSON.stringify(value)}`);
				}
			} catch (error) {
				this.log(`  Error filling ${fieldName}: ${error}`);
			}
		}

		if (modified) {
			await item.saveTx();
			this.log(`Item auto-filled successfully from preset`);
		}
	}
};
