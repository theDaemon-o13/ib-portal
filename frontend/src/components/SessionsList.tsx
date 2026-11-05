import type { SessionItem } from '../api/client';
import { describeUserAgent } from '../auth/user-agent';

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Список сессий (1.10.0): «Мои сессии» в профиле и сессии пользователя в «Пользователях и ролях».
 * onRevoke — «Завершить» у каждой, кроме текущей (её закрывает «Выйти»).
 */
export function SessionsList({ items, busy, onRevoke }: { items: readonly SessionItem[]; busy: boolean; onRevoke: (s: SessionItem) => void }) {
  if (!items.length) return <p className="hint">Открытых сессий нет</p>;
  return (
    <div className="tbl-wrap">
      <table className="cat-tbl sessions-tbl">
        <thead>
          <tr><th>Устройство</th><th>IP</th><th>Вход</th><th>Последняя активность</th><th>Срок</th><th aria-label="Действие" /></tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} data-session={s.id} className={s.current ? 'sel' : undefined}>
              <td>
                <b>{describeUserAgent(s.userAgent)}</b>
                {s.current && <span className="chip info">Это устройство</span>}
              </td>
              <td>{s.ip ?? '—'}</td>
              <td>{when(s.createdAt)}</td>
              <td>{when(s.lastSeenAt)}</td>
              <td>
                {s.expiresAt ? `до ${when(s.expiresAt)}` : 'бессрочно'}
                <div className="hint">{s.remember ? 'Запомнить меня' : 'до закрытия браузера'}</div>
              </td>
              <td>
                {!s.current && <button className="btn ghost sm" type="button" disabled={busy} onClick={() => onRevoke(s)}>Завершить</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
