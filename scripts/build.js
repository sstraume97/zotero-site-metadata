#!/usr/bin/env node

/**
 * Build script for Site Metadata Zotero plugin
 * Creates an XPI file for installation
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const EXTENSION_DIR = path.join(PROJECT_ROOT, "extension");
const LICENSE_PATH = path.join(PROJECT_ROOT, "LICENSE");
const XPI_NAME = "site-metadata.xpi";

const log = (message) => console.log(`[Build] ${message}`);

const ensureDistDir = () => {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
};

const cleanDist = () => {
  const xpiPath = path.join(DIST_DIR, XPI_NAME);
  if (fs.existsSync(xpiPath)) {
    fs.unlinkSync(xpiPath);
    log(`Cleaned old ${XPI_NAME}`);
  }
};

const createStagingDirectory = () => {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-metadata-"));

  const copyEntry = (source, destination) => {
    const stats = fs.statSync(source);
    if (stats.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fs.readdirSync(source)) {
        copyEntry(path.join(source, entry), path.join(destination, entry));
      }
    } else {
      fs.copyFileSync(source, destination);
    }
  };

  if (!fs.existsSync(EXTENSION_DIR)) {
    throw new Error(
      `Extension directory not found at ${EXTENSION_DIR}. Cannot build XPI.`,
    );
  }

  fs.mkdirSync(stagingDir, { recursive: true });

  for (const entry of fs.readdirSync(EXTENSION_DIR)) {
    copyEntry(
      path.join(EXTENSION_DIR, entry),
      path.join(stagingDir, entry),
    );
  }

  if (fs.existsSync(LICENSE_PATH)) {
    copyEntry(LICENSE_PATH, path.join(stagingDir, "LICENSE"));
  }

  return stagingDir;
};

const buildXPI = () => {
  log("Building XPI...");

  ensureDistDir();
  cleanDist();

  const stagingDir = createStagingDirectory();
  const xpiPath = path.join(DIST_DIR, XPI_NAME);
  const zipCommand = `zip -r "${xpiPath}" .`;

  try {
    execSync(zipCommand, { cwd: stagingDir, stdio: "inherit" });
    log(`Successfully created ${XPI_NAME} in dist/`);

    const stats = fs.statSync(xpiPath);
    log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
  } catch (error) {
    console.error("Error building XPI:", error.message);
    process.exit(1);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
};

const watch = () => {
  log("Watching for changes...");

  const gatherFiles = (dir) => {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return gatherFiles(resolved);
      }
      return resolved;
    });
  };

  const filesToWatch = [
    ...gatherFiles(EXTENSION_DIR),
    ...(fs.existsSync(LICENSE_PATH) ? [LICENSE_PATH] : []),
  ];

  let debounceTimer = null;
  const scheduleBuild = (filename) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (filename) {
      log(`Change detected: ${path.relative(PROJECT_ROOT, filename)}`);
    }
    debounceTimer = setTimeout(() => {
      buildXPI();
    }, 150);
  };

  for (const file of filesToWatch) {
    try {
      fs.watch(file, () => scheduleBuild(file));
    } catch (error) {
      log(`Unable to watch ${file}: ${error.message}`);
    }
  }

  buildXPI();
};

const args = process.argv.slice(2);
const isWatch = args.includes("--watch") || args.includes("-w");

isWatch ? watch() : buildXPI();
