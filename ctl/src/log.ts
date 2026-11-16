// Progress messages. The CLI prints them to stderr; the extension will show them in its own UI.
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

const color = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const stderrLogger: Logger = {
  info: (m) => process.stderr.write(`${paint('1;34', '==>')} ${m}\n`),
  warn: (m) => process.stderr.write(`${paint('1;33', 'Warning:')} ${m}\n`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };
