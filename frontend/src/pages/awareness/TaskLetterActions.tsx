// «Создать письмо» и «Письмо из шаблона» в карточке задачи рассылки без черновика (1.9.0; раздел 19.5): письмо
// привязывается к задаче и запуску, открывается его карточка.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { awarenessApi, awarenessKeys } from '../../api/awareness';
import { useToast } from '../../components/Toast';
import { FromTemplateDialog } from './FromTemplateDialog';
import { ru } from './logic';

export function TaskLetterActions({ taskId, ruleTitle, plannedDate }: { taskId: string; ruleTitle: string; plannedDate: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [fromTpl, setFromTpl] = useState(false);
  const title = `${ruleTitle} — ${ru(plannedDate)}`;
  const open = (id: string) => navigate(`/awareness/letters?letter=${id}`);
  const create = useMutation({
    mutationFn: () => awarenessApi.fromTask(taskId, { title }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      await qc.invalidateQueries({ queryKey: awarenessKeys.letters });
      toast(`Создано письмо № ${r.letter.number}`);
      open(r.letter.id);
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Не удалось создать письмо', 'error'),
  });
  return (
    <div className="row gap6" data-testid="task-letter-actions">
      <button className="btn sm primary" type="button" disabled={create.isPending} onClick={() => create.mutate()}>Создать письмо</button>
      <button className="btn sm" type="button" onClick={() => setFromTpl(true)}>Письмо из шаблона</button>
      {fromTpl && <FromTemplateDialog taskId={taskId} defaultTitle={title} onClose={() => setFromTpl(false)} onCreated={(r) => { setFromTpl(false); open(r.letter.id); }} />}
    </div>
  );
}
