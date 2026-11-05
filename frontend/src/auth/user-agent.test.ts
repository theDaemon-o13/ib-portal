import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './user-agent';

describe('устройство из User-Agent', () => {
  it('браузер и ОС', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'))
      .toBe('Chrome 131 · Windows 10/11');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'))
      .toBe('Edge 131 · Windows 10/11');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox 128 · Linux');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'))
      .toBe('Safari 17 · macOS');
  });

  it('пусто и нераспознанное', () => {
    expect(describeUserAgent(null)).toBe('Неизвестное устройство');
    expect(describeUserAgent('curl/8.4.0')).toBe('curl/8.4.0');
  });
});
