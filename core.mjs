export const referenceId = '6b04268349af47255b523d29';
export const jiraOrigin = 'https://jira.mos.social';
export const editorUrl = id => `https://forms.yandex.ru/cloud/admin/${id}/edit`;
export const defaultStand = Object.freeze({server: 'Локалка', profile: 'Стол справок - главный врач', login: 'PWW', access: '1'});

export function jiraLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { /* Show a useful validation error below. */ }
  const match = url?.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i);
  if (!match || url.origin !== jiraOrigin || url.username || url.password) {
    throw new Error('Вставьте ссылку на задачу вида https://jira.mos.social/browse/ПРОЕКТ-123.');
  }
  const key = match[1].toUpperCase();
  return {key, url: `${jiraOrigin}/browse/${key}`};
}

export function splitJiraText(raw) {
  const source = raw.replace(/\r/g, '').trim();
  const numbered = /^(?:\d+\\?[.)]|#|[-*•])\s+(\S.*)$/;
  const lines = source.split('\n');
  const starts = [];
  lines.forEach((line, index) => {
    const item = line.match(numbered);
    if (item) starts.push({index, text: item[1]});
  });
  if (!starts.length) return {cases: source.split(/\n\s*\n/).map(v => v.trim()).filter(Boolean), intro: ''};

  // Plain Jira text has no closing list tag. A blank line before unindented prose ends the last item.
  const lastStart = starts.at(-1).index;
  const tail = lines.findIndex((line, index) => index > lastStart + 1 && !lines[index - 1].trim()
    && /^\S/.test(line) && !/^(?:[#*]{2,}\s|\d+(?:\.\d+)+[.)]?\s)/.test(line));
  const cases = starts.map(({index, text}, i) => {
    const end = starts[i + 1]?.index ?? (tail === -1 ? lines.length : tail);
    return [text, ...lines.slice(index + 1, end)].join('\n').trim();
  });
  const intro = [lines.slice(0, starts[0].index), tail === -1 ? [] : lines.slice(tail)]
    .map(part => part.join('\n').trim()).filter(Boolean).join('\n\n');
  return {cases, intro};
}

function readableText(element) {
  const copy = element.cloneNode(true);
  copy.querySelectorAll('script,style,img,iframe,object,button').forEach(node => node.remove());
  copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  copy.querySelectorAll('a[href]').forEach(node => {
    const label = node.textContent.trim();
    const href = node.getAttribute('href');
    if (/^https?:\/\//i.test(href) && href !== label) node.replaceWith(`${label} (${href})`);
  });
  copy.querySelectorAll('p,div,h1,h2,h3,h4,tr').forEach(node => node.append('\n\n'));
  copy.querySelectorAll('ul,ol').forEach(node => node.prepend('\n'));
  copy.querySelectorAll('li').forEach(node => { node.prepend('• '); node.append('\n'); });
  return copy.textContent.replace(/\r/g, '').replace(/\u00a0/g, ' ')
    .split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractCases(rendered, raw, document) {
  if (!rendered) return splitJiraText(raw);
  const template = document.createElement('template');
  template.innerHTML = rendered;
  const lists = [...template.content.querySelectorAll('ol,ul')].filter(node => !node.parentElement?.closest('ol,ul'));
  const cases = lists.flatMap(list => [...list.children]
    .filter(node => node.tagName === 'LI').map(readableText)).filter(Boolean);
  if (!cases.length) return splitJiraText(readableText(template.content) || raw);
  lists.forEach(node => node.remove());
  return {cases, intro: readableText(template.content)};
}

// Yandex interprets question labels and hints as Markdown. Preserve Jira text as literal content.
const literal = value => value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&');
const required = [{type: 'required'}];
const textField = (slug, label, extra = {}) => ({slug, label, type: 'string', ...extra});
const heading = (slug, label, detail) => ({slug, label, type: 'comment', header: true, ...(detail && {comment: literal(detail)})});

function descriptionWithLink(intro, source) {
  if (!source) return intro.trim();
  const {url} = jiraLink(source);
  const paragraphs = intro.split(/\n[\t ]*\n+/).map(paragraph => paragraph.split('\n').filter(line => {
    const standalone = line.trim().replace(/^(?:Ссылка на Jira|Задача Jira):\s*/i, '').replace(/\/$/, '');
    return standalone !== url;
  }).join('\n').trim()).filter(Boolean);
  paragraphs.splice(Math.min(1, paragraphs.length), 0, `Ссылка на Jira: ${url}`);
  return paragraphs.join('\n\n');
}

function introBlocks(description) {
  const pieces = [];
  let rest = description;
  while (literal(rest).length > 1000) {
    let end = 1000;
    while (literal(rest.slice(0, end)).length > 1000) end--;
    const paragraph = rest.lastIndexOf('\n\n', end);
    const space = Math.max(rest.lastIndexOf(' ', end), rest.lastIndexOf('\n', end));
    if (paragraph >= end / 2) end = paragraph;
    else if (space >= end / 2) end = space;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  pieces.push(rest);
  return pieces.map((part, index) => index === 0
    ? heading('task_intro', 'Вводные данные', part)
    : heading(`task_intro_${index + 1}`, 'Вводные данные (продолжение)', part));
}

export function draftPlan({title, source, intro, cases, stands, includeUnchecked}) {
  const name = title.trim();
  if (!name) throw new Error('Укажите название формы.');
  if (!cases.length || cases.some(value => !value.trim())) {
    throw new Error('Заполните каждый кейс или удалите пустые поля.');
  }
  const questions = introBlocks(descriptionWithLink(intro, source));
  stands.forEach((stand, index) => {
    const detail = [
      ['Сервер для тестирования', stand.server], ['Профиль', stand.profile],
      ['Логин', stand.login], ['Пароль', stand.access]
    ].filter(([, value]) => value.trim()).map(([label, value]) => `${label}: ${value.trim()}`).join('\n\n');
    if (detail) questions.push(heading(`stand_${index + 1}`, `Тестовый стенд ${index + 1}`, detail));
  });
  questions.push(textField('version', 'Версия', {validators: required}),
    textField('tester_name', 'ФИО тестировщика', {validators: required}));
  const statuses = ['Работает', 'Не работает'];
  if (includeUnchecked) statuses.push('Не проверено');
  cases.forEach((value, index) => {
    const number = index + 1;
    questions.push({slug: `case_${number}`, label: literal(value.trim()), type: 'enum', widget: 'radio',
      items: statuses.map(label => ({label})), validators: required},
    textField(`case_${number}_comment`, 'Комментарий к проверкам', {multiline: true,
      comment: 'Если возник сбой, опишите, что произошло.'}),
    {slug: `case_${number}_files`, label: 'Скриншоты к проверке', type: 'file',
      validators: [{type: 'count', value: 20}, {type: 'size', value: 20}]});
  });
  for (const question of questions) {
    if (question.label.length > 5000 || question.comment?.length > 1000) {
      throw new Error(`Сократите текст блока «${question.label.slice(0, 80)}» до лимита Яндекс Форм.`);
    }
  }
  return {name, questions};
}
