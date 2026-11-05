// «Настройки → Подпись ИБ» (1.9.0; docs/specs/awareness.md, раздел 17.3): одна на портал, RU и TJ — подпись и контакт
// для сообщений о подозрительных письмах. Вкладка — только при settings.manage и ib.work; служебная учётная запись
// её не видит. Незамороженные письма показывают новую подпись сразу, отправленные хранят текст на дату отправки.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { awarenessApi, awarenessKeys, type Signature } from '../../api/awareness';
import { useToast } from '../../components/Toast';
import { EditorFallback, LetterEditor } from './editor';
import { ruDateTime } from './logic';

export function SignatureSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: awarenessKeys.signature, queryFn: awarenessApi.signature });
  const [lang, setLang] = useState<'ru' | 'tj'>('ru');
  const [html, setHtml] = useState({ htmlRu: '', htmlTj: '' });
  const [resetKey, setResetKey] = useState('');
  const [conflict, setConflict] = useState(false);
  const reset = (s: Signature) => {
    setHtml({ htmlRu: s.htmlRu, htmlTj: s.htmlTj });
    setResetKey(`${s.version}:${Date.now()}`);
    setConflict(false);
  };
  useEffect(() => {
    if (q.data) reset(q.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.version]);

  const save = useMutation({
    mutationFn: () => awarenessApi.saveSignature({ ...html, version: q.data?.version ?? 0 }),
    onSuccess: (r) => {
      qc.setQueryData(awarenessKeys.signature, r.signature);
      reset(r.signature);
      if (r.warnings.length) r.warnings.forEach((w) => toast(w, 'warn'));
      else toast('Подпись ИБ сохранена — письма в работе показывают её сразу');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      else toast(err instanceof Error ? err.message : 'Не удалось сохранить подпись', 'error');
    },
  });

  const s = q.data;
  const dirty = !!s && (html.htmlRu !== s.htmlRu || html.htmlTj !== s.htmlTj);
  return (
    <section className="panel" data-testid="signature-settings">
      <div className="panel-h">
        <div>
          <h3>Подпись ИБ</h3>
          <span className="sub">Блок «Подпись ИБ» в учебных письмах и шаблонах: подпись отдела и контакт для сообщений о подозрительных письмах. Письма в работе показывают текущую подпись, в отправленных остаётся подпись на дату отправки.</span>
        </div>
      </div>
      <div className="panel-b aw-letter">
        {q.isError && <div className="form-error">{q.error.message}</div>}
        {conflict && (
          <div className="note conflict" role="alert">
            Подпись изменил другой пользователь — ваши изменения не сохранены.
            <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void q.refetch().then((r) => r.data && reset(r.data))}>Перечитать</button></div>
          </div>
        )}
        {s && (
          <>
            <div className="row aw-langs" role="tablist" aria-label="Язык подписи">
              {(['ru', 'tj'] as const).map((l) => (
                <button key={l} type="button" role="tab" aria-selected={lang === l} className={`aw-lang${lang === l ? ' on' : ''}`} onClick={() => setLang(l)}>{l.toUpperCase()}</button>
              ))}
              <span className="grow" />
              {s.updatedBy && s.updatedAt && <span className="hint">Изменена {ruDateTime(s.updatedAt)}, {s.updatedBy.fullName}</span>}
            </div>
            {(['ru', 'tj'] as const).map((l) => (
              <div key={l} hidden={lang !== l}>
                <Suspense fallback={<EditorFallback />}>
                  <LetterEditor label={`Подпись ИБ (${l.toUpperCase()})`} value={l === 'ru' ? html.htmlRu : html.htmlTj} resetKey={resetKey}
                    onChange={(v) => setHtml((h) => ({ ...h, [l === 'ru' ? 'htmlRu' : 'htmlTj']: v }))}
                    signatureHtml="" allowSignature={false} maxImageKb={1024} readOnly={conflict}
                    onWarning={(w) => toast(w, 'warn')} />
                </Suspense>
              </div>
            ))}
            <div className="row">
              <button className="btn primary" type="button" disabled={!dirty || save.isPending || conflict} onClick={() => save.mutate()}>Сохранить подпись</button>
              {dirty && <button className="btn" type="button" onClick={() => reset(s)}>Отменить изменения</button>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
