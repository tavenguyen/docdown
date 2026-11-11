// pdf-lib 1.17.1 is vendored unmodified in vendor/pdf-lib.min.js.
// Source: https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js
// License: https://unpkg.com/pdf-lib@1.17.1/LICENSE.md
// (copied to vendor/pdf-lib.LICENSE)
(function () {
  'use strict';

  const MAX_FILES = 20;
  const MAX_FILE_BYTES = 256 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
  const LARGE_TOTAL_BYTES = 300 * 1024 * 1024;
  const LARGE_PAGE_TOTAL = 2000;

  const SH = (typeof globalThis !== 'undefined' && globalThis.DocDown) || null;

  function docdownError(message) {
    const error = new Error(message);
    error.docdown = true;
    return error;
  }

  function warn(message) {
    if (SH && typeof SH.warn === 'function') {
      SH.warn(message);
      return;
    }
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('DocDown:', message);
    }
  }

  function pdfLibrary() {
    if (typeof globalThis === 'undefined') return null;
    return globalThis.PDFLib || globalThis.pdfLib || null;
  }

  function resolvePdfDocument(pdfDocFactory) {
    if (pdfDocFactory) return pdfDocFactory;
    const library = pdfLibrary();
    return library && library.PDFDocument ? library.PDFDocument : null;
  }

  function stripDiacritics(value) {
    const text = String(value === undefined || value === null ? '' : value);
    if (typeof text.normalize !== 'function') return text;
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function parsePartIndex(name) {
    let base = stripDiacritics(name).trim();
    if (!base) return 0;
    base = base.replace(/\.pdf$/i, '');

    // "phần 3", "phan 3" and "part 3", optionally followed by a duplicate
    // suffix such as "(1)" that Chrome adds when it saves the same name twice.
    // DocDown appends " - phần N" to the title, so a title that itself contains
    // "học phần 1" must not win over the final part marker. Scan all matches
    // and use the last one.
    const namedPattern =
      /(?:^|[^a-z0-9])(?:phan|part)\s*(?:so\s*)?[-_.:#]?\s*(\d{1,3})(?=$|[^0-9a-z])/gi;
    let named = null;
    for (const match of base.matchAll(namedPattern)) {
      named = match;
    }
    if (named) {
      const value = Number(named[1]);
      return value > 0 ? value : 0;
    }

    // A bare number next to the extension: "3.pdf", "tài liệu 3.pdf",
    // "tailieu-3.pdf". A trailing Chrome duplicate suffix is removed first so
    // "tài liệu 3 (1).pdf" still detects part 3; a bare "(3)" is deliberately
    // ignored because Chrome uses "(1)" to distinguish two saves with the same
    // title.
    const withoutDuplicate = base.replace(/\s*\(\d{1,3}\)\s*$/, '');
    const trailing = withoutDuplicate.match(/(?:^|[\s._-])(\d{1,3})\s*$/);
    if (!trailing) return 0;
    const value = Number(trailing[1]);
    return value > 0 ? value : 0;
  }

  function toPartIndex(entry) {
    const value = Number(entry && entry.partIndex);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  function entryName(entry, index) {
    return entry && entry.name ? String(entry.name) : 'PDF ' + (index + 1);
  }

  function entryBytes(entry) {
    if (!entry) return 0;
    if (entry.file && Number.isFinite(Number(entry.file.size)) && Number(entry.file.size) >= 0) {
      return Number(entry.file.size);
    }
    if (Number.isFinite(Number(entry.size)) && Number(entry.size) >= 0) {
      return Number(entry.size);
    }
    if (entry.buffer && Number.isFinite(Number(entry.buffer.byteLength))) {
      return Number(entry.buffer.byteLength);
    }
    return 0;
  }

  function totalBytesOf(entries) {
    return entries.reduce(function (sum, entry) {
      return sum + entryBytes(entry);
    }, 0);
  }

  function totalPagesOf(entries) {
    return entries.reduce(function (sum, entry) {
      const count = Number(entry && entry.pageCount);
      return sum + (Number.isFinite(count) && count > 0 ? count : 0);
    }, 0);
  }

  function indexIssues(entries) {
    const counts = Object.create(null);
    const unknown = [];
    let max = 0;

    entries.forEach(function (entry) {
      const part = toPartIndex(entry);
      if (!part) {
        unknown.push(entry);
        return;
      }
      counts[part] = (counts[part] || 0) + 1;
      if (part > max) max = part;
    });

    const duplicates = [];
    Object.keys(counts).forEach(function (key) {
      if (counts[key] > 1) duplicates.push(Number(key));
    });
    duplicates.sort(function (a, b) { return a - b; });

    const missing = [];
    for (let part = 1; part <= max; part += 1) {
      if (!counts[part]) missing.push(part);
    }

    return { duplicates: duplicates, missing: missing, unknown: unknown };
  }

  // Sorts indexed parts first, ascending, and leaves files whose part could not
  // be detected after them in their original selection order.
  function sortEntries(entries) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const sorted = list.map(function (entry, index) {
      return { entry: entry, index: index, part: toPartIndex(entry) };
    }).sort(function (a, b) {
      const left = a.part > 0 ? a.part : Number.MAX_SAFE_INTEGER;
      const right = b.part > 0 ? b.part : Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.index - b.index;
    }).map(function (item) {
      return item.entry;
    });

    const issues = indexIssues(list);
    if (issues.duplicates.length) {
      warn('Trùng số phần: ' + issues.duplicates.join(', ') + '.');
    }
    if (issues.missing.length) {
      warn('Thiếu số phần: ' + issues.missing.join(', ') + '.');
    }
    if (issues.unknown.length) {
      warn('Không nhận ra số phần trong ' + issues.unknown.length + ' file.');
    }

    return sorted;
  }

  function validateEntries(entries, expectedTotal, skipCheck) {
    const list = Array.isArray(entries) ? entries : [];

    if (list.length < 1) {
      return { ok: false, reason: 'empty' };
    }
    if (list.length > MAX_FILES) {
      return { ok: false, reason: 'too-many' };
    }

    let totalBytes = 0;
    for (let i = 0; i < list.length; i += 1) {
      const size = entryBytes(list[i]);
      if (size > MAX_FILE_BYTES) {
        return {
          ok: false,
          reason: 'file-too-large',
          name: entryName(list[i], i),
          size: size
        };
      }
      totalBytes += size;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, reason: 'total-too-large', size: totalBytes };
    }

    for (let i = 0; i < list.length; i += 1) {
      const pageCount = Number(list[i] && list[i].pageCount);
      if (!Number.isFinite(pageCount) || pageCount <= 0) {
        return { ok: false, reason: 'pages', name: entryName(list[i], i) };
      }
    }

    const expected = Number(expectedTotal);
    if (!skipCheck && Number.isFinite(expected) && expected > 0) {
      const actual = totalPagesOf(list);
      if (actual !== expected) {
        return {
          ok: false,
          reason: 'page-count',
          expected: expected,
          actual: actual
        };
      }
    }

    return { ok: true };
  }

  function describeValidation(result) {
    if (!result) return 'Các file đã chọn chưa hợp lệ.';
    switch (result.reason) {
      case 'empty':
        return 'Chưa chọn file PDF nào.';
      case 'too-many':
        return 'Chỉ ghép được tối đa ' + MAX_FILES + ' file một lần.';
      case 'file-too-large':
        return 'File "' + result.name + '" vượt quá 256 MB.';
      case 'total-too-large':
        return 'Tổng dung lượng các file vượt quá 1 GB.';
      case 'pages':
        return 'Không đọc được số trang của "' + result.name + '".';
      case 'page-count':
        return 'Tổng số trang của các file (' + result.actual +
          ') không khớp với tài liệu (' + result.expected +
          ' trang). Hãy chọn đủ các phần hoặc bật "Bỏ qua kiểm tra tổng số trang".';
      default:
        return 'Các file đã chọn chưa hợp lệ.';
    }
  }

  async function readFileEntries(files, pdfDocFactory) {
    const factory = resolvePdfDocument(pdfDocFactory);
    if (!factory || typeof factory.load !== 'function') {
      throw docdownError('Không tải được pdf-lib.');
    }

    const list = files ? Array.prototype.slice.call(files) : [];
    const entries = [];

    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      const name = entryName(file, i);

      if (!file || typeof file.arrayBuffer !== 'function') {
        throw docdownError('Không đọc được file "' + name + '".');
      }

      let buffer;
      try {
        buffer = await file.arrayBuffer();
      } catch (error) {
        throw docdownError('Không đọc được file "' + name + '".');
      }
      if (!buffer || !buffer.byteLength) {
        throw docdownError('File "' + name + '" rỗng.');
      }

      let document;
      try {
        document = await factory.load(buffer, { ignoreEncryption: false });
      } catch (error) {
        throw docdownError('Không đọc được PDF "' + name +
          '". File có thể bị hỏng hoặc đặt mật khẩu.');
      }

      let pageCount;
      try {
        pageCount = Number(document.getPageCount());
      } catch (error) {
        throw docdownError('Không đọc được số trang của "' + name + '".');
      }

      entries.push({
        file: file,
        name: name,
        partIndex: parsePartIndex(name),
        pageCount: pageCount,
        buffer: buffer
      });
    }

    return entries;
  }

  async function mergeEntries(entries, pdfDocFactory) {
    const factory = resolvePdfDocument(pdfDocFactory);
    if (!factory) {
      throw docdownError('Không tải được pdf-lib.');
    }
    if (typeof factory.load !== 'function') {
      throw docdownError('Không tải được pdf-lib.');
    }

    const list = Array.isArray(entries) ? entries.slice() : [];
    const check = validateEntries(list, 0, true);
    if (!check.ok) {
      throw docdownError(describeValidation(check));
    }

    const sorted = sortEntries(list);
    let output;
    if (typeof factory.create === 'function') {
      output = await factory.create();
    } else {
      output = new factory();
    }

    for (let i = 0; i < sorted.length; i += 1) {
      const entry = sorted[i];
      const name = entryName(entry, i);
      if (!entry || !entry.buffer) {
        throw docdownError('Thiếu dữ liệu của file "' + name +
          '". Hãy chọn lại các file.');
      }

      let source;
      try {
        source = await factory.load(entry.buffer, { ignoreEncryption: false });
      } catch (error) {
        throw docdownError('Không đọc được PDF "' + name +
          '". File có thể bị hỏng hoặc đặt mật khẩu.');
      }

      let pages;
      try {
        const indices = typeof source.getPageIndices === 'function'
          ? source.getPageIndices()
          : Array.from({ length: source.getPageCount() }, function (_, index) {
            return index;
          });
        pages = await output.copyPages(source, indices);
      } catch (error) {
        throw docdownError('Không sao chép được các trang của "' + name + '".');
      }

      if (!pages || typeof pages.length !== 'number') {
        throw docdownError('Không sao chép được các trang của "' + name + '".');
      }
      for (let page = 0; page < pages.length; page += 1) {
        output.addPage(pages[page]);
      }
    }

    let bytes;
    try {
      bytes = await output.save();
    } catch (error) {
      throw docdownError('Không tạo được file PDF ghép. Có thể không đủ bộ nhớ.');
    }
    if (!bytes || !bytes.byteLength) {
      throw docdownError('File PDF ghép bị rỗng.');
    }
    return bytes;
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    if (index === 0) return Math.round(size) + ' B';
    const digits = size >= 100 ? 0 : 1;
    return size.toFixed(digits) + ' ' + units[index];
  }

  const api = {
    parsePartIndex: parsePartIndex,
    sortEntries: sortEntries,
    validateEntries: validateEntries,
    mergeEntries: mergeEntries,
    readFileEntries: readFileEntries,
    formatBytes: formatBytes
  };

  if (typeof globalThis !== 'undefined') globalThis.DocDownMerge = api;
  if (typeof window !== 'undefined') window.DocDownMerge = api;

  function init() {
    if (typeof document === 'undefined' ||
      typeof document.getElementById !== 'function') {
      return;
    }

    const input = document.getElementById('files');
    const mergeButton = document.getElementById('merge-button');
    const statusEl = document.getElementById('merge-status');
    if (!input || !mergeButton || !statusEl) return;

    const documentTitleEl = document.getElementById('document-title');
    const expectedTotalEl = document.getElementById('expected-total');
    const fileListEl = document.getElementById('file-list');
    const fileSummaryEl = document.getElementById('file-summary');
    const emptyListEl = document.getElementById('empty-list');
    const warningsEl = document.getElementById('merge-warnings');
    const skipCheckEl = document.getElementById('skip-page-check');

    const state = {
      title: '',
      expectedTotal: 0,
      entries: [],
      busy: false,
      merged: false,
      pdfReady: false,
      generation: 0
    };

    function setStatus(message, tone) {
      statusEl.textContent = message || '';
      if (tone) statusEl.setAttribute('data-tone', tone);
      else statusEl.removeAttribute('data-tone');
    }

    function setDocumentInfo() {
      if (documentTitleEl) {
        documentTitleEl.textContent = state.title || 'Tài liệu không tên';
      }
      if (expectedTotalEl) {
        expectedTotalEl.textContent = state.expectedTotal > 0
          ? state.expectedTotal + ' trang'
          : 'Không rõ';
      }
    }

    function renderList() {
      if (!fileListEl || !emptyListEl || !fileSummaryEl) return;

      fileListEl.textContent = '';
      state.entries.forEach(function (entry, index) {
        const item = document.createElement('li');
        item.className = 'file-item';

        const badge = document.createElement('span');
        const part = toPartIndex(entry);
        badge.className = 'part-badge' + (part > 0 ? '' : ' unknown');
        badge.textContent = part > 0 ? 'Phần ' + part : 'Chưa rõ phần';

        const body = document.createElement('div');
        body.className = 'file-body';

        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = entryName(entry, index);

        const meta = document.createElement('span');
        meta.className = 'file-meta';
        const pageCount = Number(entry && entry.pageCount);
        meta.textContent = (pageCount > 0 ? pageCount + ' trang' : 'Không rõ số trang') +
          ' · ' + formatBytes(entryBytes(entry));

        body.appendChild(name);
        body.appendChild(meta);
        item.appendChild(badge);
        item.appendChild(body);
        fileListEl.appendChild(item);
      });

      fileListEl.hidden = state.entries.length === 0;
      emptyListEl.hidden = state.entries.length > 0;
      fileSummaryEl.textContent = state.entries.length
        ? state.entries.length + ' file · ' + totalPagesOf(state.entries) +
          ' trang · ' + formatBytes(totalBytesOf(state.entries))
        : '';
    }

    function updateWarnings() {
      if (!warningsEl) return;

      const issues = indexIssues(state.entries);
      const messages = [];

      if (issues.unknown.length) {
        messages.push('Không nhận ra số phần trong ' + issues.unknown.length +
          ' file; các file này được xếp theo thứ tự chọn.');
      }
      if (issues.duplicates.length) {
        messages.push('Trùng số phần: ' + issues.duplicates.join(', ') +
          '. Hãy kiểm tra lại các file.');
      }
      if (issues.missing.length) {
        messages.push('Thiếu số phần: ' + issues.missing.join(', ') + '.');
      }

      const bytes = totalBytesOf(state.entries);
      const pages = totalPagesOf(state.entries);
      if (bytes > LARGE_TOTAL_BYTES) {
        messages.push('Tổng dung lượng ' + formatBytes(bytes) +
          ' — quá trình ghép có thể cần nhiều bộ nhớ.');
      }
      if (pages > LARGE_PAGE_TOTAL) {
        messages.push('Tổng cộng ' + pages +
          ' trang — quá trình ghép có thể mất vài giây.');
      }

      warningsEl.textContent = '';
      messages.forEach(function (message) {
        const item = document.createElement('li');
        item.textContent = message;
        warningsEl.appendChild(item);
      });
      warningsEl.hidden = messages.length === 0;
    }

    function refreshValidation() {
      if (!state.pdfReady || !state.entries.length) {
        mergeButton.disabled = true;
        return false;
      }

      const check = validateEntries(
        state.entries,
        state.expectedTotal,
        !!(skipCheckEl && skipCheckEl.checked)
      );
      if (!check.ok) {
        setStatus(describeValidation(check), 'error');
        mergeButton.disabled = true;
        return false;
      }

      setStatus('Sẵn sàng ghép ' + state.entries.length + ' file · ' +
        totalPagesOf(state.entries) + ' trang · ' +
        formatBytes(totalBytesOf(state.entries)), 'info');
      mergeButton.disabled = state.busy || state.merged;
      return true;
    }

    function releaseEntries() {
      state.entries.forEach(function (entry) {
        if (entry) entry.buffer = null;
      });
    }

    async function onFilesSelected() {
      if (state.busy) return;

      const token = state.generation + 1;
      state.generation = token;
      releaseEntries();
      state.entries = [];
      state.merged = false;
      renderList();
      updateWarnings();
      mergeButton.disabled = true;

      const files = input.files ? Array.prototype.slice.call(input.files) : [];
      if (!files.length) {
        setStatus('Chọn file PDF để bắt đầu.');
        return;
      }
      if (files.length > MAX_FILES) {
        setStatus('Chỉ ghép được tối đa ' + MAX_FILES + ' file một lần.', 'error');
        return;
      }

      let selectedBytes = 0;
      let oversizedName = '';
      files.forEach(function (file) {
        const size = Number(file && file.size);
        if (!Number.isFinite(size) || size <= 0) return;
        selectedBytes += size;
        if (!oversizedName && size > MAX_FILE_BYTES) {
          oversizedName = String(file.name || 'PDF');
        }
      });
      if (oversizedName) {
        setStatus('File "' + oversizedName + '" vượt quá 256 MB.', 'error');
        return;
      }
      if (selectedBytes > MAX_TOTAL_BYTES) {
        setStatus('Tổng dung lượng các file vượt quá 1 GB.', 'error');
        return;
      }

      setStatus('Đang đọc ' + files.length + ' file PDF…', 'info');
      try {
        const read = await readFileEntries(files);
        if (token !== state.generation) {
          read.forEach(function (entry) { entry.buffer = null; });
          return;
        }
        state.entries = sortEntries(read);
        renderList();
        updateWarnings();
        refreshValidation();
      } catch (error) {
        if (token !== state.generation) return;
        state.entries = [];
        renderList();
        updateWarnings();
        setStatus(
          error && error.docdown
            ? error.message
            : 'Không đọc được các file PDF. Hãy thử chọn lại.',
          'error'
        );
        warn(error);
      }
    }

    function onSkipChanged() {
      updateWarnings();
      if (state.busy || state.merged) return;
      if (!state.entries.length) {
        mergeButton.disabled = true;
        return;
      }
      refreshValidation();
    }

    async function onMergeClicked() {
      if (state.busy || state.merged || !state.entries.length) return;

      const check = validateEntries(
        state.entries,
        state.expectedTotal,
        !!(skipCheckEl && skipCheckEl.checked)
      );
      if (!check.ok) {
        setStatus(describeValidation(check), 'error');
        mergeButton.disabled = true;
        return;
      }

      const selected = state.entries.slice();
      const pageTotal = totalPagesOf(selected);

      state.busy = true;
      mergeButton.disabled = true;
      mergeButton.textContent = 'Đang ghép…';
      input.disabled = true;
      if (skipCheckEl) skipCheckEl.disabled = true;
      setStatus('Đang ghép ' + selected.length + ' file PDF…', 'info');

      try {
        const bytes = await mergeEntries(selected);
        if (!SH || typeof SH.saveBlob !== 'function') {
          throw docdownError('Không tải được lib/core.js.');
        }
        const title = SH.buildFileName
          ? SH.buildFileName(state.title || 'document')
          : (state.title || 'document');
        SH.saveBlob(
          new Blob([bytes], { type: 'application/pdf' }),
          title + '.pdf'
        );

        state.merged = true;
        releaseEntries();
        setStatus('Đã ghép ' + pageTotal + ' trang', 'success');
      } catch (error) {
        setStatus(
          error && error.docdown
            ? error.message
            : 'Không ghép được PDF. Một file có thể bị hỏng, đặt mật khẩu hoặc máy không đủ bộ nhớ.',
          'error'
        );
        warn(error);
      } finally {
        state.busy = false;
        mergeButton.textContent = 'Ghép PDF';
        input.disabled = false;
        if (skipCheckEl) skipCheckEl.disabled = false;

        if (state.merged) {
          mergeButton.disabled = true;
        } else {
          const after = validateEntries(
            state.entries,
            state.expectedTotal,
            !!(skipCheckEl && skipCheckEl.checked)
          );
          mergeButton.disabled = !after.ok;
        }
      }
    }

    let params = null;
    try {
      params = new URLSearchParams(
        (globalThis.location && globalThis.location.search) || ''
      );
    } catch (error) {
      params = null;
    }
    if (params) {
      state.title = (params.get('title') || '').trim();
      const total = Number(params.get('total'));
      state.expectedTotal = Number.isFinite(total) && total > 0
        ? Math.floor(total)
        : 0;
    }
    setDocumentInfo();

    const library = pdfLibrary();
    state.pdfReady = !!(library && library.PDFDocument &&
      typeof library.PDFDocument.load === 'function');
    if (!state.pdfReady) {
      input.disabled = true;
      if (skipCheckEl) skipCheckEl.disabled = true;
      mergeButton.disabled = true;
      setStatus('Không tải được pdf-lib', 'error');
      return;
    }

    input.addEventListener('change', onFilesSelected);
    mergeButton.addEventListener('click', onMergeClicked);
    if (skipCheckEl) skipCheckEl.addEventListener('change', onSkipChanged);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', releaseEntries);
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading' &&
      typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }
})();
