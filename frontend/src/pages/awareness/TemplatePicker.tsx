// Выбор шаблона письма (1.13.2): «Новое письмо», «Срочная рассылка», «Письмо из шаблона». Только действующие шаблоны;
// нет ни одного — «Шаблонов пока нет» и «Создать шаблон» (переход в «Шаблоны → Новый шаблон»).
import { useNavigate } from 'react-router-dom';
import type { TemplatePage } from '../../api/awareness';
import { Select } from '../../components/Select';

export const NEW_TEMPLATE_HREF = '/awareness/templates?template=new';

export function TemplatePicker({ items, loading, value, onChange, label, optional = false, required = false, onLeave }: {
  items: TemplatePage['items'] | undefined;
  loading: boolean;
  value: string;
  onChange: (id: string) => void;
  label: string;
  optional?: boolean;
  required?: boolean;
  /** Закрыть окно перед переходом в «Шаблоны → Новый шаблон». */
  onLeave?: () => void;
}) {
  const navigate = useNavigate();
  if (!loading && items && items.length === 0) {
    return (
      <div className="aw-tpl-empty" data-testid="templates-empty">
        <span className="aw-tpl-empty-l">{label}</span>
        <span className="hint">Шаблонов пока нет</span>
        <button className="btn sm" type="button" onClick={() => { onLeave?.(); navigate(NEW_TEMPLATE_HREF); }}>Создать шаблон</button>
      </div>
    );
  }
  return (
    <label>{label}
      <Select className="inp" required={required} value={value} onChange={(e) => onChange(e.target.value)} data-testid="template-select">
        {optional ? <option value="">— без шаблона</option> : <option value="" disabled>{loading ? 'Загрузка…' : 'Выберите шаблон…'}</option>}
        {items?.map((x) => <option key={x.id} value={x.id}>{x.title}{x.tooLarge ? ' — больше лимита' : ''}</option>)}
      </Select>
    </label>
  );
}
