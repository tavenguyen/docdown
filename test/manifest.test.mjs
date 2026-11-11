import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// Chrome only accepts origin-only patterns in web_accessible_resources and
// host_permissions. Path-scoped patterns fail to load the whole extension.
function isOriginOnly(pattern) {
  return /^[a-z*]+:\/\/(\*\.)?[a-z0-9.-]+\/\*$/i.test(pattern);
}

function assertFileExists(relativePath) {
  const full = path.join(root, relativePath);
  assert.ok(fs.existsSync(full), 'missing file referenced by manifest: ' + relativePath);
}

test('manifest is a valid MV3 document', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('web_accessible_resources patterns are origin-only', () => {
  const entries = manifest.web_accessible_resources || [];
  assert.ok(entries.length > 0, 'expected at least one web_accessible_resources entry');
  for (const entry of entries) {
    assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0);
    for (const match of entry.matches) {
      assert.ok(isOriginOnly(match), 'path-scoped WAR pattern rejected by Chrome: ' + match);
    }
    for (const resource of entry.resources || []) {
      assertFileExists(resource);
    }
  }
});

test('host_permissions patterns are origin-only', () => {
  for (const pattern of manifest.host_permissions || []) {
    assert.ok(isOriginOnly(pattern), 'path-scoped host permission: ' + pattern);
  }
});

test('content script files and matches exist', () => {
  const scripts = manifest.content_scripts || [];
  assert.ok(scripts.length > 0);
  for (const entry of scripts) {
    assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0);
    for (const file of entry.js || []) assertFileExists(file);
    for (const file of entry.css || []) assertFileExists(file);
  }
});

test('background, print page and icons exist', () => {
  assertFileExists(manifest.background.service_worker);
  assertFileExists('print.html');
  for (const file of Object.values(manifest.icons || {})) assertFileExists(file);
});

test('every provider module on disk is loaded by the print page and the service worker', () => {
  const shipped = fs.readdirSync(path.join(root, 'providers'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => 'providers/' + name)
    .sort();

  const printHtml = fs.readFileSync(path.join(root, 'print.html'), 'utf8');
  const printScripts = new Set(
    Array.from(printHtml.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi), (match) => match[1])
  );

  const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const importCall = backgroundSource.match(/importScripts\(([^)]*)\)/);
  assert.ok(importCall, 'background.js must call importScripts');
  const imported = new Set(
    (importCall[1].match(/["']([^"']+)["']/g) || []).map((value) => value.slice(1, -1))
  );

  for (const file of shipped) {
    assert.ok(printScripts.has(file), 'provider not loaded by print.html: ' + file);
    assert.ok(imported.has(file), 'provider not imported by background.js: ' + file);
  }
});

test('every provider module on disk is loaded by the content script', () => {
  const shipped = fs.readdirSync(path.join(root, 'providers'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => 'providers/' + name);
  const loaded = new Set(
    (manifest.content_scripts || []).flatMap((entry) => entry.js || [])
  );
  for (const file of shipped) {
    assert.ok(loaded.has(file), 'provider not listed in content_scripts.js: ' + file);
  }
});
