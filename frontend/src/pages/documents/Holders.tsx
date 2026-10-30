// «Сейчас у» и «кто действует» под этапом (релиз 1.4.0, шаг 5): один вид в реестре и в карточке документа.
import type { DocItem } from '../../api/documents';
import { approversLabel, holdersLabel, OWNER_HINT } from './logic';

type Holders = NonNullable<DocItem['holders']>;

/** «Сейчас у: <ФИО>»; этап начальника ИБ без отметки — «Начальник ИБ не назначен» красным; отключённый — с подсказкой. */
export function HoldersLine({ holders, testId, className = 'hint' }: { holders: Holders; testId: string; className?: string }) {
  const off = holders.people.some((p) => p.inactive);
  return (
    <div className={`${className}${holders.missingHead ? ' late-t' : ''}`} data-testid={testId} title={off ? OWNER_HINT : undefined}>
      Сейчас у: {className === 'hint' ? holdersLabel(holders) : <b>{holdersLabel(holders)}</b>}
    </div>
  );
}

/** Под этапом карточки: роль из подсказки и кто действует (та же функция на backend, что «Сейчас у»). */
export function StageWho({ hint, approvers, missingHead }: { hint: string; approvers: readonly string[]; missingHead: boolean }) {
  if (!hint) return null;
  const who = approversLabel({ approvers, missingHead });
  return <small data-testid="stage-who" className={missingHead ? 'late-t' : undefined}>{hint}{who ? `: ${who}` : ''}</small>;
}
