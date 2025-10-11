#!/usr/bin/env node

/**
 * Build script for Site Metadata Zotero plugin
 * Creates an XPI file for installation
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const XPI_NAME = 'site-metadata.xpi';

const FILES_TO_INCLUDE = [
	'manifest.json',
	'bootstrap.js',
	'site-metadata.js'
];

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

const buildXPI = () => {
	log('Building XPI...');

	ensureDistDir();
	cleanDist();

	const xpiPath = path.join(DIST_DIR, XPI_NAME);
	const zipCommand = `zip -r "${xpiPath}" ${FILES_TO_INCLUDE.join(' ')}`;

	try {
		execSync(zipCommand, { cwd: __dirname, stdio: 'inherit' });
		log(`Successfully created ${XPI_NAME} in dist/`);

		const stats = fs.statSync(xpiPath);
		log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
	} catch (error) {
		console.error('Error building XPI:', error.message);
		process.exit(1);
	}
};

const watch = () => {
	log('Watching for changes...');

	const filesToWatch = FILES_TO_INCLUDE.map(f => path.join(__dirname, f));

	for (const file of filesToWatch) {
		if (fs.existsSync(file)) {
			fs.watch(file, (eventType, filename) => {
				log(`File changed: ${filename}`);
				buildXPI();
			});
		}
	}

	buildXPI();
};

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');

isWatch ? watch() : buildXPI();
