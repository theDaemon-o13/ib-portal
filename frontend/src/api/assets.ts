// Сверка активов (релиз 1.6.0, ADR-0031): факты считает backend при запросе.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

export type AssetChecks = JsonOf<paths['/api/v1/assets/checks']['get']['responses'][200]>;
export type AssetFact = AssetChecks['items'][number];
export type AssetSection = AssetChecks['sections'][number];

export const assetsApi = {
  checks: () => request<AssetChecks>('GET', '/api/v1/assets/checks'),
};
