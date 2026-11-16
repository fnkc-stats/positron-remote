// Answers one agent request: "agent ping | list | stop <project> | start" (start reads JSON from stdin).
// On a server this is the forced command of the positron account, one line per user in authorized_keys:
//   command="node /opt/positron-ctl/positron-ctl.cjs serve --user alice",restrict,port-forwarding,permitopen="127.0.0.1:*" ssh-ed25519 AAAA... alice
// Whatever the user asks for over SSH arrives in SSH_ORIGINAL_COMMAND and is only parsed here, never run.
import type { Agent } from './agent.ts';
import type { Reply, StartRequest } from './protocol.ts';

const MAX_REQUEST = 64 * 1024;

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_REQUEST) throw new Error('request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

/** Words of a client command line; "positron-ctl" in front is optional. */
export function parseCommand(line: string): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'positron-ctl') words.shift();
  if (words[0] !== 'agent') throw new Error(`unsupported command: '${line.trim()}' (expected: agent ping|list|stop|start)`);
  return words.slice(1);
}

export async function handle(agent: Agent, words: string[], input: () => Promise<string>): Promise<unknown> {
  const [cmd, arg, extra] = words;
  if (extra !== undefined) throw new Error('too many arguments');
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
      throw new Error(`unknown agent command: '${cmd ?? ''}' (ping, list, stop <project>, start)`);
  }
}

/** Runs the request and prints the reply as one JSON line; returns the exit code. */
export async function answer(run: () => Promise<unknown>): Promise<number> {
  let reply: Reply<unknown>;
  try {
    reply = { ok: true, result: await run() };
  } catch (e) {
    reply = { ok: false, error: (e as Error).message };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
  return reply.ok ? 0 : 1;
}
