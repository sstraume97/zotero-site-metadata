/**
 * Site Metadata Plugin - Bootstrap
 * Automatically fills metadata for websites without translators
 */

async function install() {
  Zotero.debug("Site Metadata: Installing plugin");
}

async function startup({ id, version, rootURI }) {
  Zotero.debug("Site Metadata: Starting plugin");

  Services.scriptloader.loadSubScript(`${rootURI}site-metadata.js`);
  await Zotero.SiteMetadata.init({ id, version, rootURI });
  await Zotero.SiteMetadata.addToAllWindows();

  Zotero.debug("Site Metadata: Plugin started successfully");
}

function onMainWindowLoad({ window }) {
  Zotero.SiteMetadata.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  Zotero.SiteMetadata.removeFromWindow(window);
}

function shutdown() {
  Zotero.debug("Site Metadata: Shutting down");
  Zotero.SiteMetadata.removeFromAllWindows();
  Zotero.SiteMetadata = undefined;
}

function uninstall() {
  Zotero.debug("Site Metadata: Uninstalling plugin");
}
