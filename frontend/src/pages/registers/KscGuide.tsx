// «Как загружать отчёты KSC» (1.6.4): порядок отчётов и что проверить в KSC до выгрузки (docs/specs/assets.md, раздел 4).
// Открывается перед выбором файла, пока пользователь не отметил «Больше не показывать» (запоминается в браузере).
import { useEffect, useRef, useState } from 'react';
import { Overlay } from '../../components/Overlay';

const HIDE_KEY = 'ksc.guide.hidden';

export function kscGuideHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveHidden(hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(HIDE_KEY, '1');
    else window.localStorage.removeItem(HIDE_KEY);
  } catch {
    // хранилище недоступно — окно просто покажется снова
  }
}

const STEPS: { title: string; text: string }[] = [
  { title: 'Отчёт о развёртывании защиты', text: 'Первым. Заводит хосты из KSC, ставит группу KSC, версии агента и защиты и «Покрытие защиты». Только по нему работает «Нет в файле» — хосты, которых больше нет в KSC.' },
  { title: 'Отчёт о статусе антивирусных баз', text: 'Вторым. Статус и дата баз, IP-адрес и домен уже заведённых хостов.' },
  { title: 'Отчёт о версиях программ «Лаборатории Касперского»', text: 'Третьим. Последняя связь с Сервером администрирования, последнее появление в сети, версия агента.' },
];

export function KscGuide({ onPick, onClose }: { onPick: () => void; onClose: () => void }) {
  const [hide, setHide] = useState(kscGuideHidden);
  const pickRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    pickRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const close = (pick: boolean) => {
    saveHidden(hide);
    onClose();
    if (pick) onPick();
  };
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && close(false)}>
        <div className="modal panel ksc-guide" role="dialog" aria-modal="true" aria-labelledby="ksc-guide-title" data-testid="ksc-guide">
          <h2 id="ksc-guide-title">Как загружать отчёты KSC</h2>
          <p className="hint">Раз в месяц, три отчёта по порядку — каждый своим импортом. Каждый отчёт обновляет только свои поля.</p>
          <ol className="ksc-steps">
            {STEPS.map((s) => <li key={s.title}><b>{s.title}</b><span>{s.text}</span></li>)}
          </ol>
          <div className="note">
            <b>До выгрузки в KSC</b>
            <ul>
              <li>В свойствах шаблона отчёта поднимите лимит записей детальной части выше числа устройств: по умолчанию KSC отдаёт только 1000 строк, обрезанный отчёт портал не примет.</li>
              <li>Файл загружайте как есть — <span className="mono">.xls</span> из KSC; пересохранённый в Excel <span className="mono">.xlsx</span> тоже подойдёт.</li>
              <li>Отчёты о владельцах устройств и о реестре оборудования не нужны — портал их отклонит.</li>
            </ul>
          </div>
          <label className="check"><input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Больше не показывать перед импортом</label>
          <div className="row end">
            <button className="btn" type="button" onClick={() => close(false)}>Закрыть</button>
            <button ref={pickRef} className="btn primary" type="button" onClick={() => close(true)}>Выбрать файл</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
