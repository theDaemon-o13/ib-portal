// «Письмо» в реестре «Рассылки» (1.9.0; docs/specs/awareness.md, раздел 18, ответ 6): «№ N, версия V» существующего
// письма — ссылка на его карточку; ручной ввод и история прошлых рассылок — просто текст.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { awarenessApi, awarenessKeys } from '../../api/awareness';
import { letterRefHref, parseLetterRef } from './logic';

export type LetterRefs = ReadonlyMap<number, { id: string; lastVersionNo: number }>;

/** Письма для страницы записей одним запросом: номер → id и последняя версия. */
export function useLetterRefs(texts: readonly string[], enabled: boolean): LetterRefs {
  const numbers = [...new Set(texts.map((t) => parseLetterRef(t)?.number).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
  const q = useQuery({
    queryKey: awarenessKeys.refs(numbers),
    queryFn: () => awarenessApi.refs(numbers),
    enabled: enabled && numbers.length > 0,
    staleTime: 60_000,
  });
  return new Map((q.data?.items ?? []).map((r) => [r.number, { id: r.id, lastVersionNo: r.lastVersionNo }]));
}

/** Значение ячейки: ссылка или текст. */
export function LetterRefText({ text, refs }: { text: string; refs: LetterRefs }) {
  const href = letterRefHref(text, refs);
  return href ? <Link to={href} onClick={(e) => e.stopPropagation()} data-testid="letter-ref">{text}</Link> : <span>{text}</span>;
}

/** В карточке записи: «Открыть письмо № N» под полем, если письмо и версия есть. */
export function LetterRefLink({ text }: { text: string }) {
  const refs = useLetterRefs([text], true);
  const href = letterRefHref(text, refs);
  const p = parseLetterRef(text);
  return href && p ? <small><Link to={href} data-testid="letter-ref">Открыть письмо № {p.number}</Link></small> : null;
}
