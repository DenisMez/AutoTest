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

  function parse(source) {
    return readJson(source.replace(/^\uFEFF/, ""));
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
