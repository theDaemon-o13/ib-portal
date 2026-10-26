export const rkeys = {
  list: ['registers', 'list'] as const,
  listWith: (archived: boolean) => ['registers', 'list', archived] as const,
  detail: (id: string) => ['registers', 'detail', id] as const,
  records: (id: string) => ['registers', 'records', id] as const,
  record: (id: string) => ['registers', 'record', id] as const,
  history: (id: string) => ['registers', 'history', id] as const,
  analytics: (id: string) => ['registers', 'analytics', id] as const,
  userOptions: ['settings', 'userOptions'] as const,
};
