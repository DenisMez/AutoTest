"use strict";

const inputData = (() => {
  const text = (value) => Array.isArray(value)
    ? value.map(text).filter(Boolean).join("\n")
    : String(value ?? "").trim();

  const key = (value) => text(value).toLowerCase().replace(/["«»]/g, "").replace(/\s+/g, " ").replace(/:$/, "").trim();

  const captions = new Map([
    ["комментарий", "comment"], ["комментарий к проверкам", "comment"], ["комментарий к проверке", "comment"],
    ["скриншоты", "links"], ["скриншоты к проверке", "links"], ["скриншот к проверке", "links"],
    ["ожидаемый результат", "expected"]
  ]);
  const metadata = new Map([
    ["id", "id"], ["фио тестировщика", "tester"], ["исполнитель", "tester"], ["тестировщик", "tester"],
    ["время создания", null], ["дата ответа", null], ["дата тестирования", null],
    ["название задачи", "title"], ["версия", "version"], ["версия по", "version"],
    ["ссылка на задачу", "taskLink"],
    ["время начала заполнения формы", null], ["время затраченное на заполнение формы", null]
  ]);
  const statuses = new Map([
    ["работает", "пройден"], ["пройден", "пройден"], ["пройдено", "пройден"], ["passed", "пройден"],
    ["не работает", "провален"], ["провален", "провален"], ["провалено", "провален"], ["failed", "провален"],
    ["заблокирован", "заблокирован"], ["заблокировано", "заблокирован"], ["blocked", "заблокирован"]
  ]);
  const emailFields = new Map([
    ["действие", "action"], ["статус", "status"], ["результат", "status"], ["результат теста", "status"]
  ]);

  const newCase = (action = "", status = "") => ({ action, status, expected: "", comment: "", links: "", images: [] });
  const newRun = () => ({ tester: "", version: "", id: "", cases: [] });
  const status = (value) => statuses.get(key(value)) ?? text(value);
  const append = (target, field, value) => { target[field] = [target[field], value].filter(Boolean).join("\n"); };

  function fileLinks(value) {
    if (Array.isArray(value)) return value.map(fileLinks).filter(Boolean).join("\n");
    if (value && typeof value === "object") {
      if (typeof value.url === "string") return value.url;
      if (typeof value.path !== "string") return "";
      const query = new URLSearchParams({path: value.path});
      if (typeof value.hash === "string") query.set("hash", value.hash);
      return `https://forms.yandex.ru/cloud/files?${query}`;
    }
    const content = text(value);
    if (/^[\[{]/.test(content)) {
      try { return fileLinks(JSON.parse(content)); } catch { /* Keep non-JSON attachment text. */ }
    }
    return content;
  }

  function readPairs(pairs) {
    const run = newRun();
    let current;
    for (const [label, raw] of pairs) {
      const name = key(label);
      const value = captions.get(name) === "links" ? fileLinks(raw) : text(raw);
      if (!name) {
        if (value) throw new Error("В выгрузке есть значение без названия поля.");
      } else if (metadata.has(name)) {
        const field = metadata.get(name);
        if (field) run[field] = value;
      } else if (captions.has(name)) {
        if (!current && value) throw new Error("Комментарий или скриншот указан раньше кейса.");
        if (current) append(current, captions.get(name), value);
      } else {
        current = newCase(text(label), status(value));
        run.cases.push(current);
      }
    }
    if (!run.cases.length) throw new Error("В ответе отсутствуют кейсы.");
    return run;
  }

  function readJson(source) {
    let records;
    try {
      records = JSON.parse(source);
    } catch {
      throw new Error("JSON повреждён. Проверьте, что выгрузка скопирована целиком.");
    }
    const isPair = (item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string";
    if (records && !Array.isArray(records) && typeof records === "object") records = [records];
    if (!Array.isArray(records) || !records.length) throw new Error("В JSON нет ответов.");
    if (records.every(isPair)) records = [records];
    return records.map((record) => {
      if (Array.isArray(record) && record.every(isPair)) return readPairs(record);
      if (record && !Array.isArray(record) && typeof record === "object") return readPairs(Object.entries(record));
      throw new Error("Ожидается JSON-выгрузка ответов Яндекс Форм.");
    });
  }

  function delimiter(source) {
    const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
    let quoted = false;
    for (const char of source) {
      if (char === '"') quoted = !quoted;
      if (quoted) continue;
      if (char === "\n" || char === "\r") break;
      if (counts.has(char)) counts.set(char, counts.get(char) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }

  function readCsv(source) {
    const sep = delimiter(source);
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let closed = false;
    const finishField = () => { row.push(field); field = ""; closed = false; };
    const finishRow = () => { finishField(); if (row.some((part) => part.trim())) rows.push(row); row = []; };
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
          closed = true;
        } else {
          field += char;
        }
      } else if (char === sep) {
        finishField();
      } else if (char === "\r" || char === "\n") {
        finishRow();
        if (char === "\r" && source[i + 1] === "\n") i++;
      } else if (char === '"' && !field && !closed) {
        quoted = true;
      } else if (closed && char !== " ") {
        throw new Error("В CSV найдено лишнее значение после закрывающей кавычки.");
      } else if (!closed) {
        field += char;
      }
    }
    if (quoted) throw new Error("В CSV не закрыта кавычка. Проверьте, что выгрузка скопирована целиком.");
    if (row.length || field) finishRow();
    const [headers, ...records] = rows;
    if (!headers || headers.length < 2 || !records.length) throw new Error("В CSV должны быть заголовки и хотя бы один ответ.");
    return records.map((record, index) => {
      if (record.length !== headers.length) {
        throw new Error("В записи № " + (index + 1) + " число полей отличается от заголовка CSV.");
      }
      return readPairs(headers.map((label, i) => [label, record[i]]));
    });
  }

  function readEmail(source) {
    const run = newRun();
    let item = newCase();
    let field = "action";
    const finish = () => {
      if (["action", "expected", "status", "comment", "links"].some((name) => item[name].trim())) {
        for (const name of ["action", "expected", "comment", "links"]) item[name] = item[name].trim();
        item.status = status(item.status);
        run.cases.push(item);
        item = newCase();
      }
      field = "action";
    };
    for (const line of source.split(/\r?\n/)) {
      const heading = line.match(/^\s*(?:кейс|сценарий)\s*№?\s*\d+\s*[:.)-]?\s*(.*)$/i);
      if (heading) {
        finish();
        item.action = heading[1].trim();
        continue;
      }
      const match = line.match(/^\s*([^:]{1,60}):\s*(.*)$/);
      const name = match ? key(match[1]) : "";
      if (match && metadata.has(name)) {
        const field = metadata.get(name);
        if (field) run[field] = match[2].trim();
        continue;
      }
      const mapped = captions.get(name) ?? emailFields.get(name);
      if (mapped) {
        field = mapped;
        append(item, field, match[2]);
      } else {
        item[field] += (item[field] ? "\n" : "") + line;
      }
    }
    finish();
    if (!run.cases.length) throw new Error("В тексте отсутствуют кейсы.");
    return [run];
  }

  function parse(source, format = "") {
    const input = source.replace(/^\uFEFF/, "").replace(/^(?:[ \t]*\r?\n)+/, "");
    if (!input.trim()) throw new Error("Добавьте содержимое выгрузки или письма.");
    if (format === "json" || (!format && /^\s*[\[{]/.test(input))) return readJson(input);
    if (format === "csv" || (!format && /^(?:"?ID"?[,;\t]|[^\r\n]*[,;\t]"?ФИО тестировщика"?[,;\t])/i.test(input))) {
      return readCsv(input);
    }
    return readEmail(input);
  }

  function decode(bytes) {
    const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
    if (header[0] === 0xff && header[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (header[0] === 0xfe && header[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("windows-1251").decode(bytes);
    }
  }

  function httpUrl(value) {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url;
    } catch {
      // The value is left as plain text when it is not a web URL.
    }
    return null;
  }

  const linkEntries = (value) => [...new Set(
    text(value).split(/\n|[,;]\s*(?=https?:\/\/|\/(?:cloud\/)?files\?)|\s+(?=https?:\/\/|\/(?:cloud\/)?files\?)/i).map(text).filter(Boolean)
  )];

  function taskUrl(value) {
    const url = httpUrl(value);
    return url && (url.pathname !== "/" || url.search) ? url : null;
  }

  function imageNames(value) {
    const url = httpUrl(value) ?? (value.startsWith("/") ? httpUrl("https://forms.yandex.ru" + value) : null);
    let string = url?.searchParams.get("path") || url?.pathname || value;
    try { string = decodeURIComponent(string); } catch { /* preserve malformed percent escapes */ }
    const name = string.split(/[/\\]/).pop().normalize("NFC").toLowerCase();
    return [name, name.replace(/^[0-9a-f]{20,40}_/, "")];
  }

  const includedRuns = (runs) => runs.filter((run) => !run.excluded);
  return { parse, decode, newRun, newCase, status, httpUrl, taskUrl, linkEntries, imageNames, includedRuns };
})();
