import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mergeSource = fs.readFileSync(path.join(root, 'merge.js'), 'utf8');
const mergeHtml = fs.readFileSync(path.join(root, 'merge.html'), 'utf8');

function loadMerge() {
  // No document in the context: merge.js must expose its API and skip init().
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(mergeSource, context, { filename: 'merge.js' });
  return context.DocDownMerge;
}

const merge = loadMerge();

function entry(name, pageCount, size) {
  return {
    name: name,
    partIndex: 0,
    pageCount: pageCount,
    size: size === undefined ? 10 : size
  };
}

function stubFactory() {
  const outputBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const calls = {
    create: 0,
    load: [],
    copyPages: [],
    addPage: [],
    save: 0
  };

  function makeDocument(meta) {
    return {
      meta: meta,
      getPageCount() { return meta.pageCount; },
      getPageIndices() {
        return Array.from({ length: meta.pageCount }, (_, index) => index);
      },
      async copyPages(source, indices) {
        calls.copyPages.push({
          from: source.meta.name,
          indices: indices.slice()
        });
        return indices.map((index) => ({ from: source.meta.name, index: index }));
      },
      addPage(page) {
        calls.addPage.push(page);
      },
      async save() {
        calls.save += 1;
        return outputBytes;
      }
    };
  }

  return {
    calls: calls,
    outputBytes: outputBytes,
    async create() {
      calls.create += 1;
      return makeDocument({ name: 'output', pageCount: 0 });
    },
    async load(buffer) {
      calls.load.push(buffer);
      return makeDocument(buffer);
    }
  };
}

test('merge.js exposes the merge API and skips init when there is no document', () => {
  assert.equal(typeof merge, 'object');
  for (const name of [
    'parsePartIndex', 'sortEntries', 'validateEntries',
    'mergeEntries', 'readFileEntries', 'formatBytes'
  ]) {
    assert.equal(typeof merge[name], 'function', name + ' must be exported');
  }
});

test('parsePartIndex reads Vietnamese, English and bare part numbers', () => {
  const cases = [
    ['tài liệu - phần 2 (trang 257–510).pdf', 2],
    ['phan 3.pdf', 3],
    ['part 4.pdf', 4],
    ['doc 5.pdf', 5],
    ['part 12.PDF', 12],
    ['tài liệu 3 (1).pdf', 3],
    ['tài liệu - phần 2 (1).pdf', 2],
    ['Học phần 1 - Giáo trình - phần 3 (trang 257–510).pdf', 3],
    ['tailieu-7.pdf', 7]
  ];

  for (const [name, expected] of cases) {
    assert.equal(merge.parsePartIndex(name), expected, name);
  }
});

test('parsePartIndex rejects missing, zero and duplicate-only numbers', () => {
  for (const name of ['phần.pdf', '0.pdf', 'abc.pdf', '(1).pdf', 'phần 0.pdf', '']) {
    assert.equal(merge.parsePartIndex(name), 0, JSON.stringify(name));
  }
});

test('sortEntries sorts known parts and keeps unknown files in selection order', () => {
  const unknownA = { name: 'scan a' };
  const part3 = { name: 'part 3', partIndex: 3 };
  const part1 = { name: 'part 1', partIndex: 1 };
  const unknownB = { name: 'scan b' };
  const part2 = { name: 'part 2', partIndex: 2 };
  const input = [unknownA, part3, part1, unknownB, part2];

  const sorted = merge.sortEntries(input);

  assert.deepEqual(
    Array.from(sorted, (item) => item.name),
    ['part 1', 'part 2', 'part 3', 'scan a', 'scan b']
  );
  assert.deepEqual(input.map((item) => item.name),
    ['scan a', 'part 3', 'part 1', 'scan b', 'part 2'],
    'sortEntries must not mutate the input');
  assert.equal(sorted.length, input.length);

  const first = { name: 'first', partIndex: 2 };
  const second = { name: 'second', partIndex: 2 };
  assert.deepEqual(
    Array.from(merge.sortEntries([first, second]), (item) => item.name),
    ['first', 'second'],
    'equal part indexes keep selection order'
  );
});

test('validateEntries enforces count, size, page and expected-total limits', () => {
  assert.equal(merge.validateEntries([], 0, false).reason, 'empty');
  assert.equal(merge.validateEntries([entry('one', 1)], 1, false).ok, true);

  const tooMany = Array.from({ length: 21 }, (_, index) =>
    entry('part ' + (index + 1), 1, 1));
  assert.equal(merge.validateEntries(tooMany, 0, false).reason, 'too-many');

  const oversized = merge.validateEntries(
    [entry('huge.pdf', 1, 256 * 1024 * 1024 + 1)], 0, false);
  assert.equal(oversized.reason, 'file-too-large');
  assert.equal(oversized.name, 'huge.pdf');
  assert.equal(oversized.size, 256 * 1024 * 1024 + 1);

  const totalTooLarge = Array.from({ length: 5 }, () =>
    entry('big.pdf', 1, 250 * 1024 * 1024));
  assert.equal(merge.validateEntries(totalTooLarge, 0, false).reason,
    'total-too-large');

  assert.equal(merge.validateEntries([entry('zero.pdf', 0)], 0, false).reason,
    'pages');

  const mismatch = merge.validateEntries(
    [entry('a.pdf', 2), entry('b.pdf', 3)], 10, false);
  assert.equal(mismatch.reason, 'page-count');
  assert.equal(mismatch.expected, 10);
  assert.equal(mismatch.actual, 5);

  assert.equal(merge.validateEntries(
    [entry('a.pdf', 2), entry('b.pdf', 3)], 10, true).ok, true,
  'skipCheck bypasses the expected total');
});

test('validateEntries accepts the exact file and total boundaries', () => {
  const maxFile = 256 * 1024 * 1024;
  assert.equal(merge.validateEntries([entry('exact.pdf', 1, maxFile)], 0, false).ok,
    true);

  const four = Array.from({ length: 4 }, () =>
    entry('quarter.pdf', 1, maxFile));
  assert.equal(merge.validateEntries(four, 0, false).ok, true,
    'four 256 MB files are exactly the 1 GB total');
});

test('mergeEntries copies pages in part order and returns the merged bytes', async () => {
  const entries = [
    {
      name: 'doc - phần 3.pdf',
      partIndex: 3,
      pageCount: 2,
      buffer: { name: 'p3', pageCount: 2, byteLength: 20 }
    },
    {
      name: 'doc - phần 1.pdf',
      partIndex: 1,
      pageCount: 1,
      buffer: { name: 'p1', pageCount: 1, byteLength: 10 }
    },
    {
      name: 'doc - phần 2.pdf',
      partIndex: 2,
      pageCount: 3,
      buffer: { name: 'p2', pageCount: 3, byteLength: 30 }
    }
  ];
  const originalOrder = entries.map((item) => item.name);
  const factory = stubFactory();

  const bytes = await merge.mergeEntries(entries, factory);

  assert.deepEqual(Array.from(bytes), Array.from(factory.outputBytes));
  assert.deepEqual(
    factory.calls.copyPages.map((call) => call.from),
    ['p1', 'p2', 'p3'],
    'parts are merged in ascending part order'
  );
  assert.deepEqual(
    factory.calls.copyPages.map((call) => call.indices),
    [[0], [0, 1, 2], [0, 1]]
  );
  assert.equal(factory.calls.addPage.length, 6);
  assert.equal(factory.calls.create, 1);
  assert.equal(factory.calls.load.length, 3);
  assert.equal(factory.calls.save, 1);
  assert.deepEqual(entries.map((item) => item.name), originalOrder,
    'the input array is not mutated');
  assert.equal(entries[0].buffer.name, 'p3');
});

test('mergeEntries rejects invalid entries before loading or creating a PDF', async () => {
  const factory = stubFactory();

  await assert.rejects(
    () => merge.mergeEntries([], factory),
    /Chưa chọn file PDF nào/
  );
  assert.equal(factory.calls.create, 0);
  assert.equal(factory.calls.load.length, 0);

  const noPages = [{
    name: 'broken.pdf',
    partIndex: 1,
    pageCount: 0,
    buffer: { name: 'broken', pageCount: 0, byteLength: 1 }
  }];
  await assert.rejects(
    () => merge.mergeEntries(noPages, factory),
    /Không đọc được số trang/
  );
  assert.equal(factory.calls.create, 0);
  assert.equal(factory.calls.load.length, 0);
});

test('readFileEntries reads each arrayBuffer and page count', async () => {
  const buffers = [
    new Uint8Array([1, 2, 3]).buffer,
    new Uint8Array([4, 5]).buffer
  ];
  const files = [
    {
      name: 'Tài liệu - phần 2.pdf',
      size: 3,
      arrayBuffer: async () => buffers[0]
    },
    {
      name: 'Tài liệu - phần 1.pdf',
      size: 2,
      arrayBuffer: async () => buffers[1]
    }
  ];
  const loads = [];
  const factory = {
    async load(buffer, options) {
      loads.push({ buffer: buffer, options: options });
      return {
        getPageCount: () => (buffer.byteLength === 3 ? 4 : 1)
      };
    }
  };

  const entries = await merge.readFileEntries(files, factory);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'Tài liệu - phần 2.pdf');
  assert.equal(entries[0].partIndex, 2);
  assert.equal(entries[0].pageCount, 4);
  assert.equal(entries[0].buffer, buffers[0]);
  assert.equal(entries[0].file, files[0]);
  assert.equal(entries[1].partIndex, 1);
  assert.equal(entries[1].pageCount, 1);
  assert.equal(entries[1].buffer, buffers[1]);

  assert.equal(loads.length, 2);
  assert.equal(loads[0].buffer, buffers[0]);
  assert.equal(loads[0].options.ignoreEncryption, false);

  await assert.rejects(() => merge.readFileEntries(files), /pdf-lib/);
});

test('formatBytes formats byte, kilobyte, megabyte and gigabyte sizes', () => {
  const cases = [
    [0, '0 B'],
    [-1, '0 B'],
    [NaN, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [300 * 1024 * 1024, '300 MB'],
    [1024 * 1024 * 1024, '1.0 GB']
  ];

  for (const [value, expected] of cases) {
    assert.equal(merge.formatBytes(value), expected, String(value));
  }
});

test('merge.html loads core, pdf-lib and merge.js in order without inline code', () => {
  const scripts = Array.from(
    mergeHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi),
    (match) => match[1]
  );
  assert.deepEqual(scripts, [
    'lib/core.js',
    'vendor/pdf-lib.min.js',
    'merge.js'
  ]);

  const inlineScripts = mergeHtml.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi) || [];
  assert.deepEqual(inlineScripts, [], 'merge.html must not contain inline scripts');
  assert.deepEqual(mergeHtml.match(/\son[a-z]+\s*=/gi) || [], [],
    'merge.html must not contain inline event handlers');
  assert.equal(/javascript\s*:/i.test(mergeHtml), false);

  const vendor = path.join(root, 'vendor', 'pdf-lib.min.js');
  assert.ok(fs.existsSync(vendor), 'vendor/pdf-lib.min.js must exist');
  assert.ok(fs.statSync(vendor).size > 400 * 1024,
    'the vendored pdf-lib must be the real build');
});
