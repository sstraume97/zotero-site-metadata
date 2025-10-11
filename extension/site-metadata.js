/**
 * Site Metadata - Main Plugin Logic
 * Learns metadata patterns from existing items and auto-fills new entries
 */

Zotero.SiteMetadata = {
  id: null,
  version: null,
  rootURI: null,
  presets: {},
  blocklist: null,
  notifierID: null,
  userWhitelist: new Set(),
  userBlacklist: new Set(),
  windowResources: new WeakMap(),
  updateQueue: Promise.resolve(),
  itemDomainCache: new Map(),

  // Configuration
  CONFIG: {
    FIELDS_TO_INFER: [
      "itemType",
      "creators",
      "blogTitle",
      "publicationTitle",
      "websiteTitle",
      "websiteType",
      "language",
    ],
    MIN_ITEMS_PER_DOMAIN: 1,
    STORAGE_KEY: "extensions.sitemetadata.presets",
    USER_WHITELIST_KEY: "extensions.sitemetadata.whitelist",
    USER_BLACKLIST_KEY: "extensions.sitemetadata.blacklist",
  },

  async init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    this.log("Initializing Site Metadata plugin");

    await this.loadPresets();
    await this.loadPreferences();

    // Build blocklist from translators
    this.blocklist = await this.getTranslatorDomains();
    this.log(`Blocklist contains ${this.blocklist.size} domains`);

    // Register item notifier for auto-update and auto-fill
    this.registerNotifier();

    await this.updatePresets();
  },

  log: (msg) => Zotero.debug(`Site Metadata: ${msg}`),

  async addToWindow(window) {
    if (!window || !window.document) return;

    const doc = window.document;
    const resources = { elements: [], listeners: [] };

    const createElement = (tag) =>
      doc.createXULElement ? doc.createXULElement(tag) : doc.createElement(tag);

    const contextMenu = doc.getElementById("zotero-itemmenu");
    if (contextMenu) {
      const menuItem = createElement("menuitem");
      menuItem.id = "site-metadata-suggest";
      menuItem.setAttribute("label", "Suggest Site Metadata");
      menuItem.classList.add("menuitem-iconic");
      menuItem.setAttribute("image", `${this.rootURI}icons/icon48.png`);
      menuItem.hidden = true;
      menuItem.disabled = true;
      menuItem.addEventListener("command", () => {
        this.handleManualFill(window).catch((error) =>
          this.log(`Error during manual fill: ${error}`),
        );
      });

      const updateMenuState = () => {
        try {
          const items = window.ZoteroPane?.getSelectedItems?.() ?? [];
          const hasSelection = items.length > 0;
          menuItem.hidden = !hasSelection;

          if (!hasSelection) {
            menuItem.disabled = true;
            return;
          }

          const hasSuggestion = items.some((item) => {
            const result = this.shouldSkipItem(item);
            if (result.skip || !result.domain) return false;
            const preset = this.presets[result.domain];
            if (!preset) return false;
            const missingFields = this.getFillableFields(item, preset);
            return missingFields.length > 0;
          });

          menuItem.disabled = !hasSuggestion;
        } catch (error) {
          this.log(`Error updating menu state: ${error}`);
        }
      };

      contextMenu.addEventListener("popupshowing", updateMenuState);
      resources.listeners.push({
        target: contextMenu,
        type: "popupshowing",
        handler: updateMenuState,
      });

      contextMenu.appendChild(menuItem);
      resources.elements.push(menuItem);
    }

    if (resources.elements.length || resources.listeners.length) {
      this.windowResources.set(window, resources);
    }
  },

  async addToAllWindows() {
    const windows = Zotero.getMainWindows();
    await Promise.all(windows.map((window) => this.addToWindow(window)));
  },

  removeFromWindow(window) {
    const resources = this.windowResources.get(window);
    if (!resources) return;

    resources.listeners.forEach(({ target, type, handler }) => {
      try {
        target.removeEventListener(type, handler);
      } catch (error) {
        this.log(`Error removing listener ${type}: ${error}`);
      }
    });

    resources.elements.forEach((element) => {
      try {
        element.remove();
      } catch (error) {
        this.log(`Error removing element: ${error}`);
      }
    });

    this.windowResources.delete(window);
  },

  removeFromAllWindows() {
    Zotero.getMainWindows().forEach((window) => this.removeFromWindow(window));

    this.notifierID && Zotero.Notifier.unregisterObserver(this.notifierID);
  },

  // ===== PRESET STORAGE =====

  async loadPresets() {
    try {
      const stored = Zotero.Prefs.get(this.CONFIG.STORAGE_KEY);
      if (stored) {
        this.presets = JSON.parse(stored);
        this.log(
          `Loaded ${Object.keys(this.presets).length} presets from storage`,
        );
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

  async loadPreferences() {
    this.userWhitelist = this.loadDomainSet(this.CONFIG.USER_WHITELIST_KEY);
    this.userBlacklist = this.loadDomainSet(this.CONFIG.USER_BLACKLIST_KEY);
    this.log(
      `Loaded ${this.userWhitelist.size} whitelisted and ${this.userBlacklist.size} blacklisted domains`,
    );
  },

  loadDomainSet(prefKey) {
    try {
      const stored = Zotero.Prefs.get(prefKey);
      if (!stored) return new Set();

      const values = JSON.parse(stored);
      if (!Array.isArray(values)) return new Set();

      return new Set(
        values.map((value) => this.normalizeDomain(value)).filter(Boolean),
      );
    } catch (error) {
      this.log(`Error loading domains for ${prefKey}: ${error}`);
      return new Set();
    }
  },

  async savePreferences() {
    try {
      Zotero.Prefs.set(
        this.CONFIG.USER_WHITELIST_KEY,
        JSON.stringify(Array.from(this.userWhitelist)),
      );
      Zotero.Prefs.set(
        this.CONFIG.USER_BLACKLIST_KEY,
        JSON.stringify(Array.from(this.userBlacklist)),
      );
      this.log("Saved domain overrides");
    } catch (error) {
      this.log(`Error saving preferences: ${error}`);
    }
  },

  normalizeDomain(domain) {
    if (!domain) return null;

    const normalized = domain
      .toString()
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/$/, "")
      .toLowerCase();

    if (!normalized) return null;

    const isValid =
      /^[a-z0-9.-]+$/.test(normalized) &&
      normalized.includes(".") &&
      !normalized.endsWith(".");
    return isValid ? normalized : null;
  },

  enqueueUpdate(task) {
    this.updateQueue = this.updateQueue.then(task).catch((error) => {
      this.log(`Error updating presets: ${error}`);
    });

    return this.updateQueue;
  },

  // ===== NOTIFIER FOR AUTO-UPDATE AND AUTO-FILL =====

  registerNotifier() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (event, type, ids) => {
          if (type !== "item") return;

          try {
            switch (event) {
              case "add":
                await this.handleItemsChanged(ids, { isNew: true });
                break;
              case "modify":
                await this.handleItemsChanged(ids, { isNew: false });
                break;
              case "trash":
              case "delete":
                await this.handleItemsRemoved(ids);
                break;
              default:
                break;
            }
          } catch (error) {
            this.log(`Error processing notifier event ${event}: ${error}`);
          }
        },
      },
      ["item"],
    );
  },

  async handleItemsChanged(ids, { isNew }) {
    const items = await Promise.all(
      ids.map(async (id) => {
        try {
          return await Zotero.Items.getAsync(id);
        } catch (error) {
          this.log(`Unable to load item ${id}: ${error}`);
          return null;
        }
      }),
    );

    const domainsToUpdate = new Set();
    const domainsToClean = new Set();

    for (const item of items) {
      if (!item) continue;

      const previousDomain = this.itemDomainCache.get(item.id) || null;

      if (isNew) {
        await this.autoFillItem(item);
      }

      const result = this.shouldSkipItem(item);
      if (result.skip) {
        if (previousDomain) {
          this.itemDomainCache.delete(item.id);
          domainsToClean.add(previousDomain);
        }
        continue;
      }

      const { domain } = result;
      this.itemDomainCache.set(item.id, domain);
      domainsToUpdate.add(domain);

      if (previousDomain && previousDomain !== domain) {
        domainsToClean.add(previousDomain);
      }
    }

    for (const domain of domainsToClean) {
      await this.updatePresetsForDomain(domain);
    }

    for (const domain of domainsToUpdate) {
      await this.updatePresetsForDomain(domain);
    }
  },

  async handleItemsRemoved(ids) {
    const domains = new Set();

    ids.forEach((id) => {
      const domain = this.itemDomainCache.get(id);
      if (domain) {
        domains.add(domain);
        this.itemDomainCache.delete(id);
      }
    });

    for (const domain of domains) {
      await this.updatePresetsForDomain(domain);
    }
  },

  // ===== DOMAIN EXTRACTION =====

  async getTranslatorDomains() {
    const translators = await Zotero.Translators.getAll();
    const webTranslators = translators.filter((t) => t.translatorType & 4);

    const domains = new Set();

    const patterns = [
      /(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi,
      /(?:www\.)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/gi,
      /([a-z0-9-]+\\\.(?:[a-z0-9-]+\\\.)*[a-z]{2,})/gi,
    ];

    const invalidChars = ["[", "(", "*", "?", "^", "$"];
    const isValidDomain = (domain) =>
      domain &&
      !invalidChars.some((char) => domain.includes(char)) &&
      domain.split(".").length >= 2 &&
      domain.length < 100;

    for (const translator of webTranslators) {
      if (!translator.target) continue;

      for (const pattern of patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(translator.target)) !== null) {
          const rawDomain = match[1]
            .replace(/\\\./g, ".")
            .replace(/^www\./, "")
            .toLowerCase();

          const domain = this.normalizeDomain(rawDomain);
          domain && isValidDomain(domain) && domains.add(domain);
        }
      }
    }

    return domains;
  },

  getDomain: (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  },

  // ===== ITEM VALIDATION =====

  shouldSkipItem(item, options = {}) {
    const { ignoreTranslatorBlock = false } = options;
    const EXCLUDED_CATALOGS = new Set([
      "Embedded Metadata",
      "Web Page",
      "ZoteroSnapshot",
      "",
    ]);

    if (!item.isRegularItem() || item.deleted || item.isAttachment()) {
      return { skip: true, reason: "not regular item" };
    }

    const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
    if (!["webpage", "blogPost"].includes(itemType)) {
      return { skip: true, reason: `itemType: ${itemType}` };
    }

    const identifiers = ["DOI", "ISBN", "ISSN"];
    if (identifiers.some((id) => item.getField(id))) {
      return { skip: true, reason: "has identifier (DOI/ISBN/ISSN)" };
    }

    const libraryCatalog = item.getField("libraryCatalog");
    if (libraryCatalog && !EXCLUDED_CATALOGS.has(libraryCatalog)) {
      return { skip: true, reason: `libraryCatalog: ${libraryCatalog}` };
    }

    const url = item.getField("url");
    if (!url) {
      return { skip: true, reason: "no URL" };
    }

    const domain = this.getDomain(url);
    if (!domain) {
      return { skip: true, reason: "invalid URL" };
    }

    if (this.userBlacklist.has(domain)) {
      return { skip: true, reason: `user blacklist: ${domain}`, domain };
    }

    if (this.userWhitelist.has(domain)) {
      return { skip: false, domain, forced: true };
    }

    if (this.blocklist.has(domain) && !ignoreTranslatorBlock) {
      return {
        skip: true,
        reason: `blocklisted (has translator): ${domain}`,
        domain,
      };
    }

    return { skip: false, domain };
  },

  // ===== FIELD HANDLING =====

  hasFieldValue(item, fieldName) {
    if (fieldName === "creators") {
      return item
        .getCreators()
        .some((c) => Zotero.CreatorTypes.getName(c.creatorTypeID) === "author");
    }

    if (fieldName === "itemType") return true;

    try {
      const value = item.getField(fieldName);
      return Boolean(value?.trim());
    } catch {
      return false;
    }
  },

  getFieldValue(item, fieldName) {
    if (fieldName === "creators") {
      return item
        .getCreators()
        .filter(
          (c) => Zotero.CreatorTypes.getName(c.creatorTypeID) === "author",
        )
        .map((c) => ({
          firstName: c.firstName ?? "",
          lastName: c.lastName ?? c.name ?? "",
          creatorType: "author",
        }));
    }

    if (fieldName === "itemType") {
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
    lastTouched:
      item.dateModified > item.dateAdded ? item.dateModified : item.dateAdded,
    title: item.getField("title") || null,
  }),

  // ===== PRESET GENERATION (Majority Voting) =====

  generatePresetForDomain(items) {
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
            actualValue: fieldValue,
          });
        }

        const entry = valueCounts.get(serializedValue);
        entry.count++;

        if (
          new Date(itemMeta.lastTouched) >
          new Date(entry.mostRecentItem.lastTouched)
        ) {
          entry.mostRecentItem = itemMeta;
        }
      }

      if (valueCounts.size === 0) continue;

      let selectedEntry = null;
      let maxCount = 0;

      for (const [, entry] of valueCounts) {
        const shouldSelect =
          entry.count > maxCount ||
          (entry.count === maxCount &&
            selectedEntry &&
            new Date(entry.mostRecentItem.lastTouched) >
              new Date(selectedEntry.mostRecentItem.lastTouched));

        if (shouldSelect) {
          maxCount = entry.count;
          selectedEntry = entry;
        }
      }

      if (!selectedEntry) continue;

      const fieldValue = selectedEntry.actualValue;

      if (fieldName === "creators" && fieldValue.length === 0) continue;

      preset[fieldName] = fieldValue;

      const totalItemsWithField = Array.from(valueCounts.values()).reduce(
        (sum, e) => sum + e.count,
        0,
      );

      fieldSources[fieldName] = {
        lastTouched: selectedEntry.mostRecentItem.lastTouched,
        title: selectedEntry.mostRecentItem.title,
        voteCount: selectedEntry.count,
        totalItemsWithField,
        uniqueValues: valueCounts.size,
      };
    }

    if (Object.keys(preset).length === 0) return null;

    return {
      ...preset,
      _stats: {
        totalItemsFromDomain: items.length,
        mostRecentItemDate: items[0].lastTouched,
        fieldSources,
      },
    };
  },

  // ===== PRESET UPDATES =====

  async updatePresets() {
    return this.enqueueUpdate(async () => {
      this.log("Updating all presets...");

      const search = new Zotero.Search();
      search.libraryID = Zotero.Libraries.userLibraryID;
      const itemIDs = await search.search();

      // Group items by domain
      const domainMap = new Map();
      this.itemDomainCache.clear();

      for (const id of itemIDs) {
        const item = await Zotero.Items.getAsync(id);
        const result = this.shouldSkipItem(item);

        if (result.skip) {
          this.itemDomainCache.delete(item.id);
          continue;
        }

        const { domain } = result;
        this.itemDomainCache.set(item.id, domain);

        if (!domainMap.has(domain)) {
          domainMap.set(domain, []);
        }

        domainMap.get(domain).push(this.getItemMetadata(item));
      }

      this.presets = Object.fromEntries(
        Array.from(domainMap.entries())
          .filter(
            ([, items]) => items.length >= this.CONFIG.MIN_ITEMS_PER_DOMAIN,
          )
          .map(([domain, items]) => [
            domain,
            this.generatePresetForDomain(items),
          ])
          .filter(([, preset]) => preset),
      );

      await this.savePresets();
      this.log(`Updated ${Object.keys(this.presets).length} presets`);
    });
  },

  async updatePresetsForDomain(domain) {
    if (!domain) return;

    return this.enqueueUpdate(async () => {
      this.log(`Updating preset for domain: ${domain}`);

      const search = new Zotero.Search();
      search.libraryID = Zotero.Libraries.userLibraryID;
      const itemIDs = await search.search();

      const items = [];
      for (const id of itemIDs) {
        const item = await Zotero.Items.getAsync(id);
        const result = this.shouldSkipItem(item);

        if (result.skip || result.domain !== domain) {
          if (this.itemDomainCache.get(item.id) === domain) {
            this.itemDomainCache.delete(item.id);
          }
          continue;
        }

        this.itemDomainCache.set(item.id, domain);
        items.push(this.getItemMetadata(item));
      }

      if (items.length >= this.CONFIG.MIN_ITEMS_PER_DOMAIN) {
        const preset = this.generatePresetForDomain(items);
        if (preset) {
          this.presets[domain] = preset;
          await this.savePresets();
          this.log(`Updated preset for ${domain} (${items.length} items)`);
        }
      } else if (this.presets[domain]) {
        delete this.presets[domain];
        await this.savePresets();
        this.log(`Removed preset for ${domain} (insufficient items)`);
      }
    });
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
            this.log(
              `  Changed item type: ${currentItemType} → ${presetItemType}`,
            );
          }
        } catch (error) {
          this.log(`  Error changing item type: ${error}`);
        }
      }
    }

    // Apply other preset fields (excluding stats and itemType)
    for (const [fieldName, value] of Object.entries(preset)) {
      if (["_stats", "itemType"].includes(fieldName)) continue;

      try {
        // Only fill if field is empty
        if (!this.hasFieldValue(item, fieldName)) {
          if (fieldName === "creators") {
            value.forEach((creator, index) => {
              item.setCreator(
                item.getCreators().length,
                creator,
                Zotero.CreatorTypes.getID(creator.creatorType),
              );
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
  },

  getFillableFields(item, preset) {
    const fields = [];

    if (preset.itemType) {
      const currentItemType = Zotero.ItemTypes.getName(item.itemTypeID);
      if (currentItemType !== preset.itemType) {
        fields.push({ fieldName: "itemType", value: preset.itemType });
      }
    }

    for (const [fieldName, value] of Object.entries(preset)) {
      if (["_stats", "itemType"].includes(fieldName)) continue;
      if (!this.hasFieldValue(item, fieldName)) {
        fields.push({ fieldName, value });
      }
    }

    return fields;
  },

  describeFieldValue(fieldName, value) {
    if (fieldName === "creators" && Array.isArray(value)) {
      if (!value.length) return "No authors";
      return value
        .map(
          (creator) =>
            [creator.firstName, creator.lastName]
              .filter(Boolean)
              .join(" ")
              .trim() || creator.name,
        )
        .filter(Boolean)
        .join(", ");
    }

    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (error) {
        this.log(`Error describing ${fieldName}: ${error}`);
        return String(value);
      }
    }

    return String(value);
  },

  async handleManualFill(window) {
    const pane = window.ZoteroPane;
    const items = pane?.getSelectedItems?.() ?? [];

    if (!items.length) {
      Services.prompt.alert(
        window,
        "Site Metadata",
        "Select at least one item to suggest metadata for.",
      );
      return;
    }

    const suggestions = [];
    const skipped = [];

    for (const item of items) {
      try {
        const result = this.shouldSkipItem(item);
        if (result.skip) {
          skipped.push(
            `${item.getField("title") || item.id}: ${result.reason}`,
          );
          continue;
        }

        const preset = this.presets[result.domain];
        if (!preset) {
          skipped.push(
            `${item.getField("title") || item.id}: No preset for ${result.domain}`,
          );
          continue;
        }

        const fieldsToFill = this.getFillableFields(item, preset);
        if (!fieldsToFill.length) {
          skipped.push(
            `${item.getField("title") || item.id}: No missing fields`,
          );
          continue;
        }

        suggestions.push({ item, domain: result.domain, fieldsToFill });
      } catch (error) {
        skipped.push(`${item.getField("title") || item.id}: Error ${error}`);
      }
    }

    if (!suggestions.length) {
      const message = skipped.length
        ? `No suggestions available.\n${skipped.join("\n")}`
        : "No suggestions available.";
      Services.prompt.alert(window, "Site Metadata", message);
      return;
    }

    const message = suggestions
      .map(({ item, domain, fieldsToFill }) => {
        const header = `${item.getField("title") || "(Untitled)"} — ${domain}`;
        const body = fieldsToFill
          .map(
            ({ fieldName, value }) =>
              `• ${fieldName}: ${this.describeFieldValue(fieldName, value)}`,
          )
          .join("\n");
        return `${header}\n${body}`;
      })
      .join("\n\n");

    if (
      !Services.prompt.confirm(
        window,
        "Site Metadata",
        `${message}\n\nApply these metadata suggestions?`,
      )
    ) {
      return;
    }

    for (const { item } of suggestions) {
      await this.autoFillItem(item);
    }

    if (skipped.length) {
      this.log(`Manual fill skipped items: ${skipped.join(" | ")}`);
    }
  },

  parseDomainInput(text) {
    if (!text) return { domains: [], invalid: [] };

    const tokens = text
      .split(/[\s,;]+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const domains = [];
    const invalid = [];

    for (const token of tokens) {
      const normalized = this.normalizeDomain(token);
      if (normalized) {
        domains.push(normalized);
      } else {
        invalid.push(token);
      }
    }

    return { domains, invalid };
  },

};
