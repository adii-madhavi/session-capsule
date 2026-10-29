import fs from 'node:fs';
import readline from 'node:readline';

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

export async function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const r = rl as unknown as { _writeToOutput: (s: string) => void };
    r._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
    };
  }
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
    if (hidden) process.stdout.write('\n');
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
}

// Passphrases come from a file, the CAPSULE_PASSPHRASE variable, or a hidden
// prompt, never from a command-line argument (visible in process lists).
export async function passphrase(opts: { file?: string; confirmTwice?: boolean; purpose: string }): Promise<string | null> {
  if (opts.file) return fs.readFileSync(opts.file, 'utf8').replace(/\r?\n$/, '');
  if (process.env.CAPSULE_PASSPHRASE) return process.env.CAPSULE_PASSPHRASE;
  if (!interactive()) return null;
  const first = await ask(`Passphrase to ${opts.purpose}: `, true);
  if (opts.confirmTwice) {
    if (first.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    if ((await ask('Repeat the passphrase: ', true)) !== first) throw new Error('The passphrases did not match.');
  }
  return first;
}
