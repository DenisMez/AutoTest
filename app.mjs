import {defaultStand, draftPlan, editorUrl, extractCases, jiraLink} from './core.mjs';
import {downloadFormsAttachment, formsApi, formsAttachmentUrl, populateDraft, readIssue} from './services.mjs';
import {savedConnectionKey, savedConnectionWriter} from './connection.mjs';

const $ = id => document.getElementById(id);
let busy = false;
let job;
let reportSource;
const exporter = $('word-exporter');
const formsAuth = () => Object.fromEntries(['mode', 'org', 'token'].map(id => [id, $(id).value]));
const writeSavedConnection = savedConnectionWriter(chrome.storage.local);
let connectionRevision = 0;

async function rememberConnection() {
  const revision = ++connectionRevision;
  const remember = $('remember-token').checked;
  try {
    const saved = await writeSavedConnection(formsAuth(), remember);
    if (revision !== connectionRevision) return;
    $('token-status').textContent = saved ? 'Токен сохранён в этом профиле Chrome.'
      : remember ? 'Введите токен, чтобы запомнить его.' : 'Сохранённая копия токена удалена.';
  } catch {
    if (revision === connectionRevision) $('token-status').textContent = 'Не удалось обновить сохранённый токен. Повторите попытку.';
  }
}

window.formsScreenshots = {
  supports: link => Boolean(formsAttachmentUrl(link)),
  download: (link, signal) => downloadFormsAttachment(link, formsAuth(), {signal})
};

function sendReportSource() {
  if (reportSource && exporter.getAttribute('src')) {
    exporter.contentWindow?.postMessage({type: 'report-source', source: reportSource}, location.origin);
  }
}

exporter.addEventListener('load', sendReportSource);
$('token').addEventListener('change', () => {
  if ($('token').value.trim() && $('word-workflow').open) {
    exporter.contentWindow?.postMessage({type: 'retry-form-files'}, location.origin);
  }
});
$('remember-token').addEventListener('change', rememberConnection);
for (const id of ['mode', 'org', 'token']) {
  $(id).addEventListener('input', () => {
    if ($('remember-token').checked) rememberConnection();
  });
}
const workflows = [...document.querySelectorAll('.workflow')];
for (const workflow of workflows) {
  workflow.addEventListener('toggle', () => {
    if (!workflow.open) return;
    for (const other of workflows) {
      if (other !== workflow) other.open = false;
    }
    if (workflow.id === 'word-workflow' && !exporter.getAttribute('src')) {
      exporter.src = exporter.dataset.src;
      exporter.hidden = false;
    }
  });
}

function report(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = error ? 'yes' : 'no';
}

function showEditor(url) {
  $('result').href = url;
  $('result').hidden = false;
  const answersUrl = url.replace(/\/edit$/, '/answers');
  reportSource = {answersUrl, title: job.plan.name, taskUrl: job.taskUrl};
  chrome.storage.local.set({lastDraft: url, lastReportSource: reportSource}).catch(() => {});
  sendReportSource();
}

function numberRows() {
  [...$('stands').children].forEach((row, index) => { row.querySelector('h3 span').textContent = index + 1; });
  const rows = [...$('cases').children];
  rows.forEach((row, index) => {
    row.querySelector('.case-label span').textContent = index + 1;
    row.querySelector('[data-command="up"]').disabled = index === 0;
    row.querySelector('[data-command="down"]').disabled = index === rows.length - 1;
  });
  $('count').textContent = `(${rows.length})`;
}

function addRow(container, template, focus = true, value = '') {
  const row = $(template).content.firstElementChild.cloneNode(true);
  const input = row.querySelector('textarea, input');
  input.value = value;
  $(container).append(row);
  numberRows();
  if (focus) input.focus();
  return row;
}

function addDefaultStand() {
  const row = addRow('stands', 'stand-row', false);
  for (const input of row.querySelectorAll('[data-stand]')) input.value = defaultStand[input.dataset.stand];
}

function updateEditor() {
  $('content').disabled = busy || Boolean(job?.id);
  $('create').disabled = busy || Boolean(job?.done || job?.creationUncertain);
  $('create').textContent = job?.id && !job.done ? 'Продолжить настройку' : 'Создать черновик';
  $('next').hidden = !(job?.id || job?.creationUncertain);
  $('next').disabled = busy;
  for (const id of ['mode', 'org', 'token']) $(id).disabled = busy;
  $('recipient').disabled = busy || Boolean(job?.id);
}

async function run(action, onError = error => report(error.message, true)) {
  if (busy) return;
  busy = true;
  updateEditor();
  try { await action(); }
  catch (error) { onError(error); }
  finally { busy = false; updateEditor(); }
}

function importIssue() {
  const hasContent = $('title').value || $('intro').value || [...$('cases').querySelectorAll('textarea')].some(input => input.value.trim());
  if (hasContent && !window.confirm('Заменить текущее название, вводные данные и список кейсов текстом из Jira?')) return;
  return run(async () => {
    const link = jiraLink($('jira').value);
    report(`Загружаю ${link.key}…`);
    const issue = await readIssue(link);
    const {intro, cases} = extractCases(issue.rendered, issue.raw, document);
    $('title').value = `${issue.title} [${link.key.split('-').at(-1)}]`;
    $('intro').value = intro;
    $('cases').replaceChildren();
    for (const content of cases.length ? cases : ['']) addRow('cases', 'case-row', false, content);
    report(cases.length ? `Загружено кейсов: ${cases.length}. Проверьте вводные и порядок кейсов.`
      : 'В описании нет пунктов. Добавьте кейсы вручную.');
  });
}

function readPlan() {
  return draftPlan({title: $('title').value, source: $('jira').value.trim(), intro: $('intro').value,
    cases: [...$('cases').querySelectorAll('textarea')].map(input => input.value),
    stands: [...$('stands').children].map(row => Object.fromEntries([...row.querySelectorAll('[data-stand]')]
      .map(input => [input.dataset.stand, input.value]))), includeUnchecked: $('include-unchecked').checked});
}

async function createDraft() {
  await navigator.locks.request('jira-forms-create', {ifAvailable: true}, async lock => {
    if (!lock) throw new Error('В другой вкладке уже создаётся форма.');
    const auth = formsAuth();
    if (!auth.org.trim() || !auth.token.trim()) $('settings').open = true;
    const api = formsApi(auth);
    const recipient = $('recipient').value.trim();
    if (recipient && !$('recipient').validity.valid) throw new Error('Проверьте адрес для уведомлений.');
    if (!job?.id) {
      const plan = readPlan();
      const source = $('jira').value.trim();
      job = {plan, recipient, taskUrl: source ? jiraLink(source).url : ''};
    }
    await chrome.storage.local.set({mode: auth.mode, org: auth.org, recipient});
    await populateDraft(api, job, (message, url) => {
      if (url && ($('result').hidden || $('result').href !== url)) showEditor(url);
      report(message);
    });
    job.done = true;
    showEditor(editorUrl(job.id));
    report('Черновик готов. Отредактируйте и опубликуйте его в Яндекс Формах.');
    try { await chrome.tabs.create({url: editorUrl(job.id)}); } catch { /* The result link is already available. */ }
  });
}

$('import').addEventListener('click', importIssue);
$('add-case').addEventListener('click', () => addRow('cases', 'case-row'));
$('add-stand').addEventListener('click', () => addRow('stands', 'stand-row'));
$('content').addEventListener('click', event => {
  const button = event.target.closest('[data-command]');
  if (!button) return;
  const row = button.closest('.case,.stand');
  if (button.dataset.command === 'remove') row.remove();
  if (button.dataset.command === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
  if (button.dataset.command === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
  numberRows();
});
$('builder').addEventListener('submit', event => {
  event.preventDefault();
  if (job?.done || job?.creationUncertain) return;
  run(createDraft, error => {
    let message = error.message;
    if (job?.creationUncertain) message += ' Проверьте список форм: черновик мог создаться. Повторное создание отключено до начала новой задачи.';
    else if (job?.questionsDone && !job.mailDone) message += ' Вопросы готовы. Настройку почты можно повторить или завершить в редакторе.';
    else if (job?.id) message += ' Черновик сохранён. Продолжение добавит только недостающие блоки.';
    report(message, true);
  });
});
$('next').addEventListener('click', () => {
  job = undefined;
  for (const id of ['jira', 'title', 'intro']) $(id).value = '';
  $('cases').replaceChildren();
  $('stands').replaceChildren();
  $('include-unchecked').checked = false;
  addRow('cases', 'case-row', false);
  addDefaultStand();
  $('result').hidden = true;
  report('');
  updateEditor();
  $('jira').focus();
});

addDefaultStand();
addRow('cases', 'case-row', false);
const preferences = await chrome.storage.local.get(['mode', 'org', 'recipient', 'lastDraft', 'lastReportSource', savedConnectionKey]);
for (const id of ['mode', 'org', 'recipient']) {
  if (typeof preferences[id] === 'string') $(id).value = preferences[id];
}
const savedConnection = preferences[savedConnectionKey];
if (typeof savedConnection?.token === 'string' && savedConnection.token.trim()) {
  for (const id of ['mode', 'org', 'token']) {
    if (typeof savedConnection[id] === 'string') $(id).value = savedConnection[id];
  }
  $('remember-token').checked = true;
  $('token-status').textContent = 'Токен восстановлен из этого профиля Chrome.';
}
if (/^https:\/\/forms\.yandex\.ru\/cloud\/admin\/[a-f0-9]{24}\/edit$/i.test(preferences.lastDraft)) {
  $('result').href = preferences.lastDraft;
  $('result').hidden = false;
  const answersUrl = preferences.lastDraft.replace(/\/edit$/, '/answers');
  reportSource = preferences.lastReportSource?.answersUrl === answersUrl ? preferences.lastReportSource : {answersUrl};
  sendReportSource();
}
updateEditor();
