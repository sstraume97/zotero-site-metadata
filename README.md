# Zotero Site Metadata Plugin

Automatically fills metadata for websites without built-in translators using
learned patterns from your library.

If you also use Zotero to save blog posts or personal website articles,
this plugin will save you the trouble of manually entering metadata.

Pull requests and/or issues with suggestions for improvement are welcome!

## Installation Guide

### Quick Install

1. **Download** the XPI file from the [latest release](https://github.com/BarishNamazov/zotero-site-metadata/releases/latest)

2. **Install** in Zotero:
   - Open Zotero
   - Go to `Tools` → `Add-ons`
   - Click the gear icon (⚙️) in the top right
   - Select `Install Add-on From File...`
   - Choose the downloaded `site-metadata.xpi` file

### Building from Source

If you want to build the plugin yourself:

```bash
git clone https://github.com/BarishNamazov/zotero-site-metadata.git
cd zotero-site-metadata

# Build the XPI, no dependencies needed
npm run build

# Install dist/site-metadata.xpi in Zotero as described above
```

### Uninstallation

1. Go to `Tools` → `Add-ons`
2. Find "Site Metadata" in the list
3. Click the `...` menu → `Remove`
4. Restart Zotero

Your Zotero library items will not be affected by uninstalling the plugin.

## Future Work

- [ ] Allow the user to allow or disallow specific domains in Zotero
- your request?
