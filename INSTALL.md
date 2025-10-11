# Installation Guide

## Quick Install

1. **Download** the XPI file from the [latest release](https://github.com/BarishNamazov/zotero-site-metadata/releases/latest)

2. **Install** in Zotero:
   - Open Zotero
   - Go to `Tools` → `Add-ons`
   - Click the gear icon (⚙️) in the top right
   - Select `Install Add-on From File...`
   - Choose the downloaded `site-metadata.xpi` file
   - Click `Install Now`

3. **Restart** Zotero

4. **Verify** installation:
   - Go to `Tools` → `Developer` → `Error Console`
   - You should see messages starting with "Site Metadata:"
   - Check for "Initializing Site Metadata plugin" and "Plugin started successfully"

## Building from Source

If you want to build the plugin yourself:

```bash
# Clone the repository
git clone https://github.com/BarishNamazov/zotero-site-metadata.git
cd zotero-site-metadata

# Build the XPI
npm run build

# Install dist/site-metadata.xpi in Zotero as described above
```

## First Use

After installation, the plugin will:

1. **Analyze** your existing library (this may take a moment on first startup)
2. **Create presets** for domains with webpage/blog post items
3. **Auto-fill** new items you add from those domains

To see what presets were created:
- Go to `Tools` → `Developer` → `Run JavaScript`
- Run: `return Zotero.Prefs.get('extensions.sitemetadata.presets')`

## Troubleshooting

### "Plugin failed to load"
- Make sure you're using Zotero 7.0 or higher
- Check the Error Console for specific error messages

### "No bootstrap method found"
- The XPI structure might be incorrect
- Try rebuilding with `npm run build`

### "Presets not updating"
- Check that you have items from domains without translators
- Ensure items are type `webpage` or `blogPost`
- Verify items don't have DOI/ISBN/ISSN identifiers

## Uninstallation

1. Go to `Tools` → `Add-ons`
2. Find "Site Metadata" in the list
3. Click the `...` menu → `Remove`
4. Restart Zotero

Your Zotero library items will not be affected by uninstalling the plugin.
