import {jiraOrigin, editorUrl, referenceId} from './core.mjs';

export async function readIssue({key, url}, browser = chrome) {
  const tabs = await browser.tabs.query({url: `${jiraOrigin}/*`});
  const tab = tabs.find(tab => tab.url?.split(/[?#]/)[0] === url) ?? tabs[0];
  if (!tab) {
    await browser.tabs.create({url});
    throw new Error('Jira открыта в новой вкладке. Войдите в аккаунт и повторите загрузку.');
  }
  const [{result} = {}] = await browser.scripting.executeScript({
    target: {tabId: tab.id}, args: [key], func: async issueKey => {
      const endpoint = `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=summary,description&expand=renderedFields`;
      try {
        const response = await fetch(endpoint, {credentials: 'same-origin', signal: AbortSignal.timeout(20000)});
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) return {status: response.status};
        const body = await response.json();
        return {status: response.status, key: body.key, title: body.fields?.summary,
          raw: body.fields?.description, rendered: body.renderedFields?.description};
      } catch { return {status: 0}; }
    }
  });
  if (result?.key !== key || typeof result.title !== 'string') {
    const detail = result?.status === 404 ? 'Задача не найдена или к ней нет доступа.' : 'Проверьте вход в Jira и доступ к задаче.';
    throw new Error(detail);
  }
  return {title: result.title, raw: typeof result.raw === 'string' ? result.raw : '',
    rendered: typeof result.rendered === 'string' ? result.rendered : ''};
}

class FormsError extends Error {
  constructor(status, message) {
    super(`Яндекс Формы (${status}). ${message}`);
    this.status = status;
  }
}

function formsHeaders({mode, org, token}) {
  if (!org.trim() || !token.trim()) throw new Error('Укажите ID организации и токен Яндекс Форм.');
  return {Authorization: `${mode === 'iam' ? 'Bearer' : 'OAuth'} ${token.trim()}`,
    [mode === 'business' ? 'X-Org-Id' : 'X-Cloud-Org-Id']: org.trim()};
}

export function formsAttachmentUrl(link) {
  let original;
  try { original = new URL(link, 'https://forms.yandex.ru'); } catch { return null; }
  const route = original.pathname.replace(/\/$/, '');
  const fromForms = original.origin === 'https://forms.yandex.ru' && ['/cloud/files', '/files'].includes(route);
  const fromApi = original.origin === 'https://api.forms.yandex.net' && route === '/v1/files';
  const path = original.searchParams.get('path');
  if ((!fromForms && !fromApi) || original.username || original.password || !path?.startsWith('/') || path.startsWith('//')) return null;
  const url = new URL('https://api.forms.yandex.net/v1/files');
  url.searchParams.set('path', path);
  const hash = original.searchParams.get('hash');
  if (hash) url.searchParams.set('hash', hash);
  return url;
}

export async function downloadFormsAttachment(link, auth, {fetcher = fetch, signal} = {}) {
  const url = formsAttachmentUrl(link);
  if (!url) throw new Error('Неподдерживаемая ссылка на файл Яндекс Форм.');
  const headers = auth.token.trim() || !url.searchParams.has('hash') ? formsHeaders(auth) : {};
  let response;
  try {
    const timeout = AbortSignal.timeout(20000);
    response = await fetcher(url.href, {headers, credentials: 'omit', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
  } catch {
    throw new Error('Не удалось связаться с Яндекс Формами для загрузки скриншота.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Проверьте токен, ID организации и доступ к файлам формы.');
  }
  if (!response.ok) throw new Error(`Яндекс Формы не отдали скриншот (код ${response.status}).`);
  return response.blob();
}

export function formsApi(auth, fetcher = fetch) {
  const headers = {...formsHeaders(auth), 'Content-Type': 'application/json', 'Accept': 'application/json'};
  return async (method, path, body) => {
    let response;
    try {
      response = await fetcher(`https://api.forms.yandex.net/v1${path}`, {
        method, headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25000),
        ...(body && {body: JSON.stringify(body)})
      });
    } catch {
      throw new FormsError(0, 'Ответ сервера не получен. Проверьте подключение.');
    }
    if (!response.ok) {
      const messages = {401: 'Проверьте токен и способ входа.', 403: 'Проверьте ID организации и права доступа к формам.',
        404: 'Форма или настройка недоступна.', 429: 'Слишком много запросов. Повторите позже.'};
      throw new FormsError(response.status, messages[response.status] ?? 'Сервер отклонил операцию.');
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new FormsError(0, 'Сервер вернул неожиданный ответ.'); }
  };
}

function activeMail(groups, mustBeActive) {
  if (!Array.isArray(groups)) throw new Error('Яндекс Формы вернули неизвестный формат списка интеграций.');
  for (const group of groups) {
    if (mustBeActive && !group.active) continue;
    const mail = group.subscriptions?.find(entry => entry.type === 'email' && (!mustBeActive || entry.active));
    if (mail) return {group, mail};
  }
  return null;
}

export async function configureMail(api, id, recipient) {
  const path = `/surveys/${id}/hooks/`;
  const [newGroups, referenceGroups] = await Promise.all([
    api('GET', path), api('GET', `/surveys/${referenceId}/hooks/`)
  ]);
  const target = activeMail(newGroups, false);
  const reference = activeMail(referenceGroups, true);
  if (!target || !reference) throw new Error('Не удалось найти действие «Почта» в черновике или форме-образце.');
  const {group, mail} = target;
  const {subject, body, variables} = reference.mail;
  const approved = new Set(['form.name', 'form.answer_url', 'form.url', 'form.questions_answers']);
  const knownVariables = Array.isArray(variables) && variables.every(variable => approved.has(variable.type));
  if (!subject || !body || !knownVariables || !variables.some(variable => variable.type === 'form.questions_answers')) {
    throw new Error('Шаблон письма в форме-образце изменён. Настройте почту в редакторе черновика.');
  }
  if (!group.active) await api('PATCH', `${path}${group.id}/`, {active: true});
  await api('PATCH', `${path}${group.id}/subscriptions/${mail.id}/`, {
    type: 'email', active: true, email_to_address: recipient, subject, body,
    variables: variables.map(variable => variable.type === 'form.questions_answers'
      ? {...variable, questions: {all: true, items: []}} : variable)
  });
}

export async function populateDraft(api, job, onUpdate) {
  if (!job.id) {
    onUpdate('Создаю черновик…');
    let created;
    try {
      created = await api('POST', '/surveys/', {name: job.plan.name});
    } catch (error) {
      if (error.status === 0 || error.status >= 500) job.creationUncertain = true;
      throw error;
    }
    if (!/^[a-f0-9]{24}$/i.test(created?.id)) {
      job.creationUncertain = true;
      throw new Error('Яндекс Формы не вернули ID нового черновика.');
    }
    job.id = created.id;
    onUpdate('Черновик создан, добавляю вопросы.', editorUrl(job.id));
  }
  const path = `/surveys/${job.id}/questions/`;
  const existing = await api('GET', path);
  if (!Array.isArray(existing?.pages) || existing.pages.some(page => !Array.isArray(page.items))) {
    throw new Error('Не удалось проверить состав черновика.');
  }
  const existingQuestions = existing.pages.flatMap(page => page.items);
  const expectedSlugs = new Set(job.plan.questions.map(question => question.slug));
  if (existingQuestions.some(question => !expectedSlugs.has(question.slug))) {
    throw new Error('Состав черновика изменился. Проверьте список вопросов в редакторе.');
  }
  const slugs = new Set(existingQuestions.map(question => question.slug));
  for (const [index, question] of job.plan.questions.entries()) {
    if (slugs.has(question.slug)) continue;
    onUpdate(`Добавляю блок ${index + 1} из ${job.plan.questions.length}…`, editorUrl(job.id));
    await api('POST', path, question);
  }
  job.questionsDone = true;
  if (!job.recipient) return;
  onUpdate('Настраиваю уведомления…', editorUrl(job.id));
  await configureMail(api, job.id, job.recipient);
  job.mailDone = true;
}
