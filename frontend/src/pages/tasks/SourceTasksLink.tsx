import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { chainsApi, tkeys } from '../../api/tasks';
import { plural } from './logic';

/**
 * «Задачи: N активных» на странице группы «Уязвимостей» и реестра (1.14.0): открывает панель системной цепочки на доске.
 * Цепочки нет или её задачи не видны пользователю — ссылки нет.
 */
export function SourceTasksLink({ type, id, className = 'btn' }: { type: 'register' | 'vuln_group'; id: string; className?: string }) {
  const q = useQuery({ queryKey: tkeys.chainBySource(type, id), queryFn: () => chainsApi.bySource(type, id), retry: false });
  const c = q.data?.chain;
  if (!c) return null;
  return (
    <Link className={className} to={`/tasks?chain=${c.id}`} data-testid="source-tasks" title={`Цепочка «${c.title}»: все задачи автоматизаций`}>
      Задачи: {c.active} {plural(c.active, 'активная', 'активные', 'активных')}
    </Link>
  );
}
