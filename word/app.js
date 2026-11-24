"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const state = { runs: [], unassigned: [], pending: 0, downloading: new Map(), exporting: false };
const formLink = $("#form-link");
const titleInput = $("#title");
const taskLink = $("#task-link");
const exportButton = $("#export");
const statusLabel = (item) => inputData.status(item.status) || "Без статуса";
const reference = {
  title: "ФЛК при госпитализации (проверка решения врача и выполнения назначений)",
  exportName: "ФЛК при госпитализации проверка решения врача и выполнения н",
  form: "https://forms.yandex.ru/cloud/6b04268349af47255b523d29",
  task: "https://jira.mos.social/browse/KISEMIAS2019-21568"
};
let imagePasteTarget;
let lastForm;
const includedRuns = () => inputData.includedRuns(state.runs);
const formsFiles = window.parent !== window && window.parent.formsScreenshots;

function message(value, error = false, sticky = false) {
  const box = $("#message");
  box.textContent = value;
  box.hidden = !value;
  box.classList.toggle("error", error);
  box.classList.toggle("sticky", sticky);
}

function caseCount() {
  return includedRuns().reduce((count, run) => count + run.cases.length, 0);
}

function refreshSummary() {
  const count = caseCount();
  const active = includedRuns();
  $("#report").hidden = !active.length;
  $("#results").hidden = !active.length;
  $("#export-actions").hidden = !active.length;
  $("#summary").textContent = "Кейсов: " + count + " · Ответов: " + active.length;
  exportButton.disabled = !count || Boolean(state.pending || state.downloading.size) || state.exporting;
  $("#batch-images").disabled = !count;
  $("#retry-images").hidden = !active.some(run => run.cases.some(item => linksForDownload(item).length));
  $("#retry-images").disabled = Boolean(state.downloading.size);
}

function updateFormLink() {
  const url = inputData.httpUrl(formLink.value.trim());
  const anchor = $("#open-form");
  anchor.hidden = !url;
  const path = url?.origin === "https://forms.yandex.ru" && url.pathname;
  const id = path && path.match(/^\/cloud\/(?:admin\/)?([a-f0-9]{24})(?:\/(?:edit|answers))?\/?$/i)?.[1];
  if (url) anchor.href = id ? `https://forms.yandex.ru/cloud/admin/${id}/answers` : url.href;
  else anchor.removeAttribute("href");
  anchor.textContent = id ? "Открыть ответы" : "Открыть форму";
  if (id && !taskLink.value.trim() && reference.form.endsWith(id)) taskLink.value = reference.task;
}

function applyReportSource(force = false) {
  if (!lastForm) return;
  if (force || !formLink.value.trim()) formLink.value = lastForm.answersUrl;
  if (force || !titleInput.value.trim()) titleInput.value = lastForm.title || "";
  if (force || !taskLink.value.trim()) taskLink.value = lastForm.taskUrl || "";
  updateFormLink();
}

window.addEventListener("message", (event) => {
  if (window.parent === window || event.source !== window.parent || event.origin !== location.origin) return;
  if (event.data?.type === "retry-form-files") {
    loadScreenshots(targetRows().map(({item}) => item));
    return;
  }
  if (event.data?.type !== "report-source") return;
  const source = event.data.source;
  if (typeof source?.answersUrl !== "string" || !/^https:\/\/forms\.yandex\.ru\/cloud\/admin\/[a-f0-9]{24}\/answers$/i.test(source.answersUrl)) return;
  lastForm = source;
  if (!state.runs.length && !formLink.value.trim()) applyReportSource();
  $("#use-last-form").hidden = false;
});

function targetRows() {
  return includedRuns().flatMap((run, runIndex) => run.cases.map((item, index) => ({
    item,
    label: "Ответ " + (runIndex + 1) + " · Кейс " + (index + 1) + " · " + (item.action.trim().slice(0, 95) || "Без названия")
  })));
}

function filePreview(container, item, refreshImages) {
  container.replaceChildren();
  item.images.forEach((asset) => {
    const preview = document.createElement("div");
    preview.className = "image-item";
    const image = document.createElement("img");
    image.src = asset.preview;
    image.alt = asset.name;
    const name = document.createElement("span");
    name.textContent = asset.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Убрать";
    remove.setAttribute("aria-label", "Убрать " + asset.name);
    remove.addEventListener("click", () => {
      item.images.splice(item.images.indexOf(asset), 1);
      URL.revokeObjectURL(asset.preview);
      filePreview(container, item, refreshImages);
      refreshImages();
    });
    preview.append(image, name, remove);
    container.append(preview);
  });
}

function imageMatchesLink(asset, link) {
  return asset.sourceLink ? asset.sourceLink === link
    : inputData.imageNames(link).some((name) => inputData.imageNames(asset.name).includes(name));
}

function outstandingImages(item) {
  const available = [...item.images];
  const unfilled = inputData.linkEntries(item.links).filter((link) => {
    const match = available.findIndex((asset) => imageMatchesLink(asset, link));
    if (match === -1) return true;
    available.splice(match, 1);
    return false;
  });
  return unfilled.slice(available.filter(asset => !asset.sourceLink).length);
}

function linksForDownload(item, includePublic = false) {
  return outstandingImages(item).filter(link => formsFiles?.supports(link) || (includePublic && inputData.httpUrl(link)));
}

function renderLinks(container, value) {
  container.replaceChildren();
  inputData.linkEntries(value).forEach((link, index) => {
    const url = inputData.httpUrl(link) ?? (formsFiles?.supports(link) ? new URL(link, "https://forms.yandex.ru") : null);
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = "Открыть скриншот " + (index + 1);
    container.append(anchor);
  });
}

function bindFields(root, model, update = () => {}) {
  for (const field of root.querySelectorAll("[data-field]")) {
    const name = field.dataset.field;
    field.value = model[name];
    field.addEventListener("input", () => {
      model[name] = field.value;
      update(name);
    });
  }
}

function caseCard(run, item, index) {
  const card = $("#case-template").content.firstElementChild.cloneNode(true);
  const heading = $(".case-title", card);
  const status = $(".case-status", card);
  const previews = $(".images", card);
  const links = $(".case-links", card);
  const paste = $(".paste-image", card);
  const load = $(".load-images", card);
  const imageStatus = $(".image-status", card);
  const updateHeading = () => {
    heading.textContent = (index + 1) + ". " + (item.action.trim() || "Без названия");
    status.textContent = statusLabel(item);
    status.dataset.status = status.textContent;
  };
  const refreshImages = () => {
    const missing = outstandingImages(item).length;
    imageStatus.hidden = !missing;
    imageStatus.textContent = missing ? (state.downloading.has(item) ? "Загружаются скриншоты…" : "Не загружено скриншотов: " + missing + ".") : "";
    load.hidden = !linksForDownload(item, true).length;
    load.disabled = state.downloading.has(item);
  };
  card.open = Boolean(item.open);
  card.addEventListener("toggle", () => { item.open = card.open; });
  bindFields(card, item, (name) => {
    updateHeading();
    if (name === "links") {
      renderLinks(links, item.links);
      refreshImages();
      refreshSummary();
    }
    if (name === "action" && state.unassigned.length) renderUnassigned();
  });
  updateHeading();
  renderLinks(links, item.links);
  filePreview(previews, item, refreshImages);
  refreshImages();
  load.addEventListener("click", () => loadScreenshots([item], true));
  $("[data-field=links]", card).addEventListener("change", () => loadScreenshots([item]));
  $(".case-files", card).addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    attach(files, item);
  });
  paste.addEventListener("click", () => {
    imagePasteTarget = item;
    paste.focus();
    message("Нажмите Ctrl+V, чтобы вставить скриншот в кейс № " + (index + 1) + ".", false, true);
  });
  paste.addEventListener("blur", () => {
    if (imagePasteTarget === item) {
      imagePasteTarget = undefined;
      message("");
    }
  });
  $(".remove-case", card).addEventListener("click", () => {
    if (!window.confirm("Удалить этот кейс из отчёта?")) return;
    cancelDownloads(item);
    run.cases.splice(run.cases.indexOf(item), 1);
    for (const asset of item.images) URL.revokeObjectURL(asset.preview);
    render();
  });
  return card;
}

function addCase(run = includedRuns().at(-1)) {
  if (!run) {
    run = inputData.newRun();
    state.runs.push(run);
  }
  const item = inputData.newCase();
  item.open = true;
  run.cases.push(item);
  render();
  const view = $("#runs").children[includedRuns().indexOf(run)];
  $(".case:last-child [data-field=action]", view).focus();
}

function renderUnassigned() {
  const panel = $("#unassigned");
  panel.replaceChildren();
  panel.hidden = !state.unassigned.length;
  if (panel.hidden) return;
  const heading = document.createElement("h3");
  heading.textContent = "Выберите кейс для скриншота";
  panel.append(heading);
  const rows = targetRows();
  for (const asset of state.unassigned) {
    const row = document.createElement("div");
    row.className = "assignment";
    const name = document.createElement("span");
    name.textContent = asset.name;
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Кейс для " + asset.name);
    select.add(new Option("Выберите кейс", ""));
    rows.forEach((target, index) => select.add(new Option(target.label, String(index))));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Убрать";
    remove.addEventListener("click", () => {
      state.unassigned.splice(state.unassigned.indexOf(asset), 1);
      URL.revokeObjectURL(asset.preview);
      renderUnassigned();
    });
    select.addEventListener("change", () => {
      if (!select.value) return;
      const item = rows[Number(select.value)].item;
      item.images.push(asset);
      item.open = true;
      state.unassigned.splice(state.unassigned.indexOf(asset), 1);
      render();
    });
    row.append(name, select, remove);
    panel.append(row);
  }
}

function render() {
  const container = $("#runs");
  container.replaceChildren();
  includedRuns().forEach((run) => {
    const view = $("#run-template").content.firstElementChild.cloneNode(true);
    const updateTitle = () => { $("h3", view).textContent = runCaption(run); };
    updateTitle();
    bindFields(view, run, updateTitle);
    const cases = $(".cases", view);
    run.cases.forEach((item, i) => cases.append(caseCard(run, item, i)));
    $(".add-case", view).addEventListener("click", () => addCase(run));
    $(".exclude-run", view).addEventListener("click", () => {
      if (state.exporting) return;
      run.excluded = true;
      for (const item of run.cases) cancelDownloads(item);
      render();
      message("Ответ исключён из отчёта. Его можно вернуть в разделе «Исключённые ответы».");
    });
    container.append(view);
  });
  renderExcluded();
  renderUnassigned();
  refreshSummary();
}

function runCaption(run) {
  return `Ответ ${state.runs.indexOf(run) + 1}${run.tester.trim() ? ` · ${run.tester.trim()}` : ''}`;
}

function renderExcluded() {
  const excluded = state.runs.filter(run => run.excluded);
  $("#excluded").hidden = !excluded.length;
  $("#excluded-count").textContent = `(${excluded.length})`;
  const list = $("#excluded-runs");
  list.replaceChildren();
  for (const run of excluded) {
    const row = document.createElement("div");
    row.className = "excluded-run";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Вернуть в отчёт";
    button.addEventListener("click", () => {
      if (state.exporting) return;
      run.excluded = false;
      render();
      loadScreenshots(run.cases);
    });
    row.append(runCaption(run), button);
    list.append(row);
  }
}

function importSource(source, filename = "") {
  const extension = filename.split(".").at(-1).toLowerCase();
  const runs = inputData.parse(source, extension);
  const used = new Set(state.runs.map((run) => run.id).filter(Boolean));
  const added = runs.filter((run) => {
    if (!run.id) return true;
    if (used.has(run.id)) return false;
    used.add(run.id);
    return true;
  });
  if (!added.length) {
    message("Эти ответы уже загружены.");
    return;
  }
  state.runs.push(...added);
  const sourceName = added[0].title || filename.replace(/\.[^.]+$/, "").replace(/^\d{4}-\d{2}-\d{2}[\s_-]+/, "");
  const knownTask = [reference.exportName, reference.title].includes(sourceName);
  if (!titleInput.value.trim()) titleInput.value = knownTask ? reference.title : sourceName;
  if (!taskLink.value.trim()) {
    const importedLink = added.find((run) => inputData.taskUrl(run.taskLink))?.taskLink;
    taskLink.value = importedLink || (knownTask ? reference.task : "");
  }
  render();
  const count = added.reduce((sum, run) => sum + run.cases.length, 0);
  const skipped = runs.length - added.length;
  message("Загружено кейсов: " + count + "." + (skipped ? " Повторных ответов пропущено: " + skipped + "." : ""));
  loadScreenshots(added.flatMap(run => run.cases));
}

async function decodeImage(file) {
  let image;
  try {
    image = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error();
    const data = new Uint8Array(await png.arrayBuffer());
    return { name: file.name || "Скриншот.png", data, width: image.width, height: image.height, preview: URL.createObjectURL(png) };
  } catch {
    throw new Error("Не удалось прочитать изображение «" + file.name + "».");
  } finally {
    image?.close();
  }
}

function autoMatch(asset) {
  const found = targetRows().filter(({ item }) => inputData.linkEntries(item.links)
    .some((link) => imageMatchesLink(asset, link)));
  return found.length === 1 ? found[0].item : null;
}

async function fetchImage(link, signal) {
  let blob;
  if (formsFiles?.supports(link)) {
    blob = await formsFiles.download(link, signal);
  } else {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(link, {credentials: "omit", signal: AbortSignal.any([signal, timeout])});
    if (!response.ok) throw new Error("Не удалось скачать изображение по ссылке.");
    blob = await response.blob();
  }
  const name = inputData.imageNames(link)[1] || "Скриншот";
  const asset = await decodeImage(new File([blob], name, {type: blob.type}));
  return {...asset, sourceLink: link};
}

function cancelDownloads(item) {
  state.downloading.get(item)?.abort();
  state.downloading.delete(item);
}

async function loadScreenshots(items, includePublic = false) {
  const jobs = items.flatMap(item => {
    if (state.downloading.has(item)) return [];
    const links = linksForDownload(item, includePublic);
    if (!links.length) return [];
    const controller = new AbortController();
    state.downloading.set(item, controller);
    return [{item, links, controller}];
  });
  if (!jobs.length) return;
  render();
  message("Загружаю скриншоты из ответов…");
  let loaded = 0;
  const failures = new Set();
  async function worker() {
    while (jobs.length) {
      const {item, links, controller} = jobs.shift();
      for (const link of links) {
        if (controller.signal.aborted) break;
        try {
          const asset = await fetchImage(link, controller.signal);
          if (controller.signal.aborted || !outstandingImages(item).includes(link)) {
            URL.revokeObjectURL(asset.preview);
          } else {
            item.images.push(asset);
            loaded++;
          }
        } catch (error) {
          if (!controller.signal.aborted) failures.add(error.message);
        }
      }
      if (state.downloading.get(item) === controller) state.downloading.delete(item);
    }
  }
  await Promise.all(Array.from({length: Math.min(3, jobs.length)}, worker));
  render();
  const notes = loaded ? [`Загружено скриншотов: ${loaded}.`] : [];
  if (failures.size) notes.push(...failures, "Можно повторить загрузку или добавить файлы вручную.");
  if (notes.length) message(notes.join(" "), Boolean(failures.size), Boolean(failures.size));
}

async function attach(files, selected) {
  if (!files.length) return;
  state.pending++;
  refreshSummary();
  try {
    const results = await Promise.allSettled(files.map(decodeImage));
    let assigned = 0;
    const errors = [];
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason.message);
        continue;
      }
      const asset = result.value;
      const target = selected ? targetRows().find(({ item }) => item === selected)?.item : autoMatch(asset);
      if (target) {
        target.images.push(asset);
        target.open = true;
        assigned++;
      } else if (selected) {
        URL.revokeObjectURL(asset.preview);
      } else {
        state.unassigned.push(asset);
      }
    }
    render();
    const notes = [];
    if (assigned) notes.push("Прикреплено скриншотов: " + assigned + ".");
    if (state.unassigned.length) notes.push("Выберите кейсы для остальных скриншотов.");
    message([...notes, ...new Set(errors)].join(" "), Boolean(errors.length), Boolean(errors.length));
  } finally {
    state.pending--;
    refreshSummary();
  }
}

function filenameFor(title) {
  const basename = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "").slice(0, 120);
  return (basename || "Тестирование") + " — результаты.docx";
}

async function download() {
  if (state.exporting || state.pending || state.downloading.size) return;
  const info = {
    title: titleInput.value.trim(),
    taskLink: taskLink.value.trim(),
    version: $("#version").value.trim(),
    organization: $("#organization").value.trim(),
    postcondition: $("#postcondition").value.trim()
  };
  if (!info.title) {
    $("#report").open = true;
    message("Укажите название задачи.", true, true);
    titleInput.focus();
    return;
  }
  if (!inputData.taskUrl(info.taskLink)) {
    $("#report").open = true;
    message("Вставьте полный адрес конкретной задачи.", true, true);
    taskLink.focus();
    return;
  }
  if (state.unassigned.length) {
    $("#results").open = true;
    message("Привяжите скриншоты к кейсам или уберите лишние файлы.", true, true);
    $("#unassigned").scrollIntoView({ block: "center" });
    return;
  }
  await loadScreenshots(targetRows().map(({item}) => item));
  if (state.exporting || state.pending || state.downloading.size) return;
  const runs = includedRuns().filter((run) => run.cases.length);
  if (!runs.length) return;
  const missingIndex = targetRows().findIndex(({ item }) => outstandingImages(item).length);
  if (missingIndex !== -1) {
    $("#results").open = true;
    const card = document.querySelectorAll(".case")[missingIndex];
    card.open = true;
    card.querySelector(".case-files").focus();
    message("Не все скриншоты загрузились. Проверьте подключение к Яндекс Формам или добавьте файлы вручную.", true, true);
    return;
  }
  if (runs.some((run) => run.cases.some((item) => !item.action.trim()))) {
    $("#results").open = true;
    message("Заполните поле «Действие» у каждого кейса.", true, true);
    const field = [...document.querySelectorAll("[data-field=action]")].find((element) => !element.value.trim());
    field.closest("details").open = true;
    field.focus();
    return;
  }
  state.exporting = true;
  refreshSummary();
  try {
    const blob = await wordReport.build(runs, info);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filenameFor(info.title);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    message("Документ сформирован. Проверьте загрузки браузера.", false, true);
  } catch (error) {
    console.error(error);
    message("Не удалось сформировать Word. " + error.message, true, true);
  } finally {
    state.exporting = false;
    refreshSummary();
  }
}

formLink.addEventListener("input", updateFormLink);
$("#use-last-form").addEventListener("click", () => {
  if (formLink.value.trim() === lastForm.answersUrl) {
    applyReportSource();
    return;
  }
  if (state.pending || state.downloading.size || state.exporting) return;
  if (state.runs.length || state.unassigned.length) {
    if (!window.confirm("Начать отчёт по последнему чек-листу? Загруженные в текущий отчёт ответы и скриншоты будут сброшены.")) return;
    for (const run of state.runs) {
      for (const item of run.cases) item.images.forEach(asset => URL.revokeObjectURL(asset.preview));
    }
    state.unassigned.forEach(asset => URL.revokeObjectURL(asset.preview));
    state.runs = [];
    state.unassigned = [];
    imagePasteTarget = undefined;
    for (const id of ["version", "organization", "postcondition", "paste"]) $("#" + id).value = "";
    render();
  }
  applyReportSource(true);
  message("");
});
$("#toggle-paste").addEventListener("click", (event) => {
  const panel = $("#paste-panel");
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) $("#paste").focus();
});
$("#import-paste").addEventListener("click", () => {
  try { importSource($("#paste").value); } catch (error) { message(error.message, true, true); }
});
$("#export-file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  try {
    importSource(inputData.decode(await file.arrayBuffer()), file.name);
  } catch (error) {
    message(error.message, true, true);
  }
});
$("#batch-images").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  attach(files);
});
$("#retry-images").addEventListener("click", () => loadScreenshots(targetRows().map(({item}) => item)));
$("#manual").addEventListener("click", () => addCase());
exportButton.addEventListener("click", download);
document.addEventListener("paste", (event) => {
  if (!imagePasteTarget) return;
  const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  event.preventDefault();
  if (!images.length) {
    message("В буфере обмена нет изображения. Скопируйте скриншот и повторите вставку.", true, true);
    return;
  }
  attach(images, imagePasteTarget);
  imagePasteTarget = undefined;
});

if (window.frameElement) {
  const main = $("main");
  new ResizeObserver(() => {
    window.frameElement.style.height = `${Math.ceil(main.getBoundingClientRect().height) + 1}px`;
  }).observe(main);
}
