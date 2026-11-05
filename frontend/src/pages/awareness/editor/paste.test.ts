import { describe, expect, it } from 'vitest';
import { checkImageFile, countLinkedImages, imagesWarning, isLinkedSrc, letterBytes, replaceLinkedImages, sizeWarning } from './paste';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('вставка из Outlook и Word', () => {
  const outlook = '<p>Коллеги!</p><p><img src="cid:image001.png@01DA1234.ABCD5678" alt="Логотип"></p>'
    + "<p><img width=100 src='file:///C:/Users/x/AppData/Local/Temp/msohtmlclip1/01/clip_image002.jpg'></p>"
    + `<p><img src=https://mail.example/img.png><img src="${PNG}"></p>`;

  it('картинки по ссылке распознаются; данными — нет', () => {
    expect(['cid:a', 'file:///c:/x.jpg', 'https://x/y.png', '/api/x', '', 'data:image/svg+xml;base64,AA'].every(isLinkedSrc)).toBe(true);
    expect(isLinkedSrc(PNG)).toBe(false);
    expect(countLinkedImages(outlook)).toBe(3);
  });

  it('в буфере нет данных картинок — ссылки убираются, число не вставленных и предупреждение', () => {
    const r = replaceLinkedImages(outlook, []);
    expect(r.missing).toBe(3);
    expect(r.html).not.toMatch(/cid:|file:|mail\.example/);
    expect(r.html).toContain(PNG);
    expect(imagesWarning(r.missing)).toBe('Не вставлено изображений: 3. Картинки по ссылке не поддерживаются — сохраните их файлом и вставьте заново');
  });

  it('в буфере есть данные картинок — подставляются по порядку, недостающие — в предупреждении', () => {
    const r = replaceLinkedImages(outlook, ['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB']);
    expect(r.missing).toBe(1);
    expect(r.html).toContain('<img src="data:image/png;base64,AAA" alt="Логотип">');
    expect(r.html).toContain('<img width=100 src="data:image/jpeg;base64,BBB">');
    expect(r.html).not.toContain('mail.example');
    expect(imagesWarning(0)).toBeNull();
  });
});

describe('размер и изображения', () => {
  it('файл: только PNG, JPEG, GIF и не больше лимита', () => {
    expect(checkImageFile({ type: 'image/webp', size: 10 }, 1024)).toBe('Вставьте картинку PNG, JPEG или GIF');
    expect(checkImageFile({ type: 'image/png', size: 2 * 1024 * 1024 }, 1024)).toBe('Изображение 2048 КБ — больше допустимых 1024 КБ. Уменьшите его');
    expect(checkImageFile({ type: 'image/gif', size: 1000 }, 1024)).toBeNull();
  });

  it('размер письма — HTML обоих языков в UTF-8; предупреждение от warnLetterKb, превышение — больше maxLetterKb', () => {
    expect(letterBytes('<p>я</p>', '<p>a</p>')).toBe(17); // «я» — 2 байта
    const limits = { warnLetterKb: 1024, maxLetterKb: 2048 };
    expect(sizeWarning(1000, limits).level).toBe('ok');
    expect(sizeWarning(1024 * 1024, limits)).toEqual({ level: 'warn', text: 'Письмо 1024 КБ — каждая из 1500+ копий ляжет на почтовый сервер' });
    expect(sizeWarning(2049 * 1024, limits).level).toBe('over');
  });
});
