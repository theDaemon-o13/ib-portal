import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Ввод без отображения символов. Без терминала (ввод из конвейера) читает строку как есть. */
export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) return ask(question);
  stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Отменено'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
