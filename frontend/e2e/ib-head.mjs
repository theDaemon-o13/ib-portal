// Отметка «Является начальником ИБ» одна на портал (ADR-0027). Тесты, которые её забирают, запоминают прежнего
// держателя до теста и возвращают ему отметку в конце — в after, даже если тест упал. Не было держателя — отметка
// снимается: dev-база остаётся такой, какой была до прогона. Вызывать под пользователем с правом users.manage.

/** Все пользователи постранично (на dev их больше одной страницы). */
async function allUsers(ui) {
  return ui.evaluate(`(async () => {
    const out = [];
    for (let cursor = ''; ;) {
      const r = await fetch('/api/v1/users?limit=200' + cursor).then((x) => x.json());
      out.push(...r.items);
      if (!r.nextCursor) return out;
      cursor = '&cursor=' + encodeURIComponent(r.nextCursor);
    }
  })()`);
}

/** Держатель отметки до теста: { id, login } или null. */
export async function saveIbHead(ui) {
  const holder = (await allUsers(ui)).find((u) => u.isIbHead);
  return holder ? { id: holder.id, login: holder.login } : null;
}

const put = (ui, id, body) => ui.evaluate(`fetch('/api/v1/users/${id}/ib-head', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} })
  .then(async (r) => ({ status: r.status, body: await r.text() }))`);

/**
 * Вернуть отметку прежнему держателю (передачей от текущего) или снять, если держателя не было. Прежний держатель
 * отключён за время теста — отметку ему не вернуть (её нельзя держать отключённому): тогда снимается и сообщается.
 */
export async function restoreIbHead(ui, saved) {
  const users = await allUsers(ui);
  const current = users.find((u) => u.isIbHead) ?? null;
  if (saved) {
    const prev = users.find((u) => u.id === saved.id);
    if (current?.id === saved.id) return 'отметка у прежнего держателя';
    if (prev?.isActive) {
      const r = await put(ui, prev.id, { version: prev.version, value: true, transfer: true });
      if (r.status !== 200) throw new Error(`не удалось вернуть отметку «Начальник ИБ» ${saved.login}: ${r.status} ${r.body}`);
      return `отметка возвращена ${saved.login}`;
    }
  }
  if (current) {
    const r = await put(ui, current.id, { version: current.version, value: false });
    if (r.status !== 200) throw new Error(`не удалось снять отметку «Начальник ИБ» с ${current.login}: ${r.status} ${r.body}`);
  }
  return saved ? `прежний держатель ${saved.login} отключён — отметка снята` : 'держателя не было — отметки нет';
}
