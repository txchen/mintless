import { createInterface } from 'node:readline';

export class PasswordInputError extends Error {}

export function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY)
    throw new PasswordInputError(
      'No terminal for a hidden prompt. Use docker compose exec without -T, or pass --password-stdin.',
    );
  return new Promise((resolve, reject) => {
    let value = '';
    input.setRawMode(true);
    output.write(question);
    input.resume();
    input.setEncoding('utf8');
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      input.off('end', onEnd);
      process.off('SIGTERM', onTerm);
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new PasswordInputError('Cancelled; nothing changed.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    const onEnd = () => finish(new PasswordInputError('Input closed; nothing changed.'));
    const onTerm = () => {
      finish(new PasswordInputError('Terminated; nothing changed.'));
      process.exit(143);
    };
    input.on('data', onData);
    input.once('end', onEnd);
    process.once('SIGTERM', onTerm);
  });
}

export async function readFirstLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    rl.close();
    return line.replace(/\r$/, '');
  }
  throw new PasswordInputError('No password received on standard input; nothing changed.');
}
