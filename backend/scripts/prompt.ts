import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { createInterface as createPromiseInterface } from 'node:readline/promises';

// Без терминала (ввод из конвейера) все ответы читаются из одного потока строк:
// отдельный readline на каждый вопрос забрал бы в буфер весь ввод сразу.
let pipedLines: AsyncIterator<string> | null = null;

async function readPipedLine(question: string): Promise<string> {
  stdout.write(question);
  pipedLines ??= createInterface({ input: stdin, terminal: false })[Symbol.asyncIterator]();
  const next = await pipedLines.next();
  stdout.write('\n');
  if (next.done) throw new Error('Ввод закончился раньше, чем были получены все ответы');
  return next.value;
}

export async function ask(question: string): Promise<string> {
  if (!stdin.isTTY) return (await readPipedLine(question)).trim();
  const rl = createPromiseInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Ввод без отображения символов. Без терминала читает строку как есть. */
export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) return readPipedLine(question);
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

/** Закрыть stdin после последнего вопроса, чтобы процесс завершился. */
export function closePrompt(): void {
  void pipedLines?.return?.();
  stdin.pause();
}
