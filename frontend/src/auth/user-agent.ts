// «Мои сессии» (1.10.0): устройство из User-Agent — браузер и ОС коротко, без внешних библиотек.

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/YaBrowser\/(\d+)/, 'Яндекс Браузер'],
  [/OPR\/(\d+)/, 'Opera'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/Windows NT 10/, 'Windows 10/11'],
  [/Windows NT 6\.3/, 'Windows 8.1'],
  [/Windows NT 6\.1/, 'Windows 7'],
  [/Windows/, 'Windows'],
  [/iPhone|iPad/, 'iOS'],
  [/Mac OS X/, 'macOS'],
  [/Android/, 'Android'],
  [/Linux/, 'Linux'],
];

/** «Chrome 131 · Windows 10/11»; не распознан — исходная строка (обрезанная), пусто — «Неизвестное устройство». */
export function describeUserAgent(ua: string | null): string {
  const s = (ua ?? '').trim();
  if (!s) return 'Неизвестное устройство';
  const browser = BROWSERS.map(([re, name]) => {
    const m = re.exec(s);
    return m ? `${name} ${m[1]}` : null;
  }).find(Boolean);
  const os = SYSTEMS.find(([re]) => re.test(s))?.[1];
  if (!browser && !os) return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  return [browser, os].filter(Boolean).join(' · ');
}
