// One bounded JSON control request. Raw connect streams are handled separately by cli.ts.
import type { Agent } from './agent.ts';
import type { Readable } from 'node:stream';
import { CheckoutPinsOther, EnvironmentImageMissing } from './image-store.ts';
import type { Reply, StartRequest } from './protocol.ts';

const MAX_REQUEST = 64 * 1024;

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('request timed out')), 10_000);
  try {
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_REQUEST) throw new Error('request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
  } finally { clearTimeout(timer); }
}

/** Words of a client command line; "fnkc-ctl" in front is optional. */
export function parseCommand(line: string): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'fnkc-ctl') words.shift();
  if (words[0] !== 'agent') throw new Error(`unsupported command: '${line.trim()}' (expected: agent ping|list|stop|start|install-image)`);
  return words.slice(1);
}

export async function handle(agent: Agent, words: string[], input: () => Promise<string>, stream: () => Readable = () => process.stdin): Promise<unknown> {
  const [cmd, arg, extra] = words;
  if (cmd === 'install-image') {
    // install-image <image>: the image's manifests and blobs are the raw stdin (format in image-store.ts)
    if (words.length !== 2) throw new Error('install-image: expected <image>');
    return agent.installImage(arg, stream());
  }
  if (extra !== undefined || ((cmd === 'ping' || cmd === 'list' || cmd === 'start') && arg !== undefined)) throw new Error('too many arguments');
  switch (cmd) {
    case 'ping':
      return agent.ping();
    case 'list':
      return agent.list();
    case 'stop':
      if (!arg) throw new Error('stop: project name required');
      return agent.stop(arg);
    case 'start': {
      let req: StartRequest;
      try {
        req = JSON.parse(await input()) as StartRequest;
      } catch {
        throw new Error('start: expected a JSON request on stdin');
      }
      return agent.start(req);
    }
    default:
      throw new Error(`unknown agent command: '${cmd ?? ''}' (ping, list, stop <project>, start, install-image <image>)`);
  }
}

/** Runs the request and prints the reply as one JSON line; returns the exit code. */
export async function answer(run: () => Promise<unknown>): Promise<number> {
  let reply: Reply<unknown>;
  try {
    reply = { ok: true, result: await run() };
  } catch (e) {
    reply = {
      ok: false, error: (e as Error).message,
      ...(e instanceof EnvironmentImageMissing ? { imageMissing: e.missing } : {}),
      ...(e instanceof CheckoutPinsOther ? { checkoutPins: e.pinned } : {}),
    };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
  return reply.ok ? 0 : 1;
}
