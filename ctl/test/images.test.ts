// The Environment Images panel and fnkc-ctl images: reading the registry (pages, joined and single-architecture
// tags, identical rebuilds, the cache), the templates' pins from git, the host's images from the agent, how the
// three are joined, and what the panel shows with which buttons.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, pinsOf } from '../src/agent.ts';
import { agentConfig } from '../src/agent-config.ts';
import { clientConfig } from '../src/client/config.ts';
import {
  buildLinks, cleanupPlan, cleanupText, digestsIn, type HostImages, listPublished, overview, overviewText, parseTag, type PublishedImage,
  type RegistryListing, removalCommand, templatePins,
} from '../src/client/images.ts';
import { Docker, type ContainerJson, type ImageJson } from '../src/docker.ts';
import type { RunOptions } from '../src/exec.ts';
import { ImagesTree, type ImageItem } from '../src/images-view.ts';
import { handle } from '../src/serve.ts';
import type { HostImage } from '../src/protocol.ts';

const quiet = { info() {}, warn() {} };
const hex = (c: string) => c.repeat(64);
const sha = (c: string) => `sha256:${hex(c)}`;
const REPO = 'ghcr.io/fnkc-stats/r-env';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

test('CI tags: environments, Positron layers, and images from before environments', () => {
  assert.deepEqual(parseTag(`4.6-env-${A}-44724201766-1`), { kind: 'environment', variant: '4.6-env', series: '4.6', commit: A, runId: 44724201766, attempt: 1, arch: undefined });
  assert.deepEqual(parseTag(`positron-2026.07.1-5-${hex('5')}-arm64`), { kind: 'positron', variant: `positron-2026.07.1-5-${hex('5')}`, positron: '2026.07.1-5', baseHex: hex('5'), arch: 'arm64' });
  assert.deepEqual(parseTag(`4.6-positron-2026.07.1-5-${A}-7-2-arm64`),
    { kind: 'legacy', variant: '4.6-positron-2026.07.1-5', series: '4.6', commit: A, runId: 7, attempt: 2, arch: 'arm64' });
  assert.deepEqual(parseTag('latest'), { kind: 'other', variant: 'latest', series: undefined });
  assert.equal(buildLinks('org/infra', parseTag(`4.6-env-${A}-9-2`)).run, 'https://github.com/org/infra/actions/runs/9/attempts/2');
  assert.equal(buildLinks('org/infra', parseTag(`4.6-env-${A}-9-1`)).packages, `https://github.com/org/infra/blob/${A}/env/versions/4.6/renv.lock`);
});

test('the registry is read in pages, one entry per image, and from the cache the second time', async (t) => {
  const digest = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
  const json = (v: unknown) => Buffer.from(JSON.stringify(v));
  const store = new Map<string, Buffer>();
  const put = (b: Buffer) => { store.set(digest(b), b); return b; };
  const image = (arch: string, labels: Record<string, string>, created: string) => {
    const config = put(json({ architecture: arch, os: 'linux', created, config: { Labels: labels } }));
    const layer = put(Buffer.from(`layer ${arch} ${created}`));
    return put(json({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest(config), size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: digest(layer), size: layer.length }] }));
  };
  const labels46 = { 'r-env.r-series': '4.6', 'r-env.r-version': '4.6.2', 'positron.version': '2026.11.1-4' };
  const amd = image('amd64', labels46, '2026-11-19T22:58:39Z'), arm = image('arm64', labels46, '2026-11-19T22:58:39Z');
  const index = put(json({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digest(amd), size: amd.length, platform: { os: 'linux', architecture: 'amd64' } },
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digest(arm), size: arm.length, platform: { os: 'linux', architecture: 'arm64' } },
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha('e'), size: 2, platform: { os: 'unknown', architecture: 'unknown' } },
  ] }));
  const only45 = image('amd64', { 'r-env.r-series': '4.5', 'r-env.r-version': '4.5.3' }, '2026-11-18T10:00:00Z');
  const byTag = new Map<string, Buffer>([
    [`4.6-${A}-100-1`, index], [`4.6-${A}-100-1-amd64`, amd], [`4.6-${A}-100-1-arm64`, arm],
    [`4.6-${B}-200-1`, index], // a rebuild that gave the same image
    [`4.5-${C}-300-1-amd64`, only45], // the other architecture failed: nothing joined
    ['latest', index],
  ]);
  const pages = [[`4.6-${A}-100-1`, `4.6-${A}-100-1-amd64`, `4.6-${A}-100-1-arm64`, `4.6-${B}-200-1`], [`4.5-${C}-300-1-amd64`, 'latest', 'broken']];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/token')) return res.end(JSON.stringify({ token: 'anonymous' }));
    if (req.headers.authorization !== 'Bearer anonymous') {
      res.writeHead(401, { 'www-authenticate': `Bearer realm="http://${req.headers.host}/token",service="test"` });
      return res.end();
    }
    requests.push(req.url!);
    const url = new URL(req.url!, 'http://x');
    if (url.pathname.endsWith('/tags/list')) {
      const page = url.searchParams.get('last') ? 1 : 0;
      if (!page) res.setHeader('link', '</v2/fnkc-stats/r-env/tags/list?last=x&n=1000>; rel="next"');
      return res.end(JSON.stringify({ name: 'fnkc-stats/r-env', tags: pages[page] }));
    }
    const ref = decodeURIComponent(url.pathname.split('/').pop()!);
    const body = byTag.get(ref) ?? store.get(ref);
    if (!body) { res.writeHead(404); return res.end(); }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const where = { registry: `localhost:${(server.address() as { port: number }).port}`, repository: 'fnkc-stats/r-env' };
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = clientConfig({ cacheDir: dir });

  const listing = await listPublished(cfg, quiet, where);
  assert.equal(listing.error, undefined);
  assert.deepEqual(listing.problems.map((p) => p.split(':')[0]), ['broken']);
  assert.deepEqual(listing.images.map((i) => i.tag), [`4.6-${B}-200-1`, `4.5-${C}-300-1-amd64`]);
  const [i46, i45] = listing.images;
  assert.equal(i46.digest, digest(index));
  assert.equal(i46.reference, `${where.registry}/fnkc-stats/r-env@${digest(index)}`);
  assert.deepEqual(i46.alsoTags?.sort(), [`4.6-${A}-100-1`, 'latest'].sort());
  assert.deepEqual(i46.architectures, ['amd64', 'arm64']);
  assert.equal(i46.labels['r-env.r-version'], '4.6.2');
  assert.ok(i46.size! > 0);
  assert.equal(i45.incomplete, true);
  assert.deepEqual(i45.architectures, ['amd64']);

  requests.length = 0;
  const again = await listPublished(cfg, quiet, where);
  assert.deepEqual(again.images.map((i) => i.tag), listing.images.map((i) => i.tag));
  assert.deepEqual(requests.filter((r) => !r.includes('/tags/list') && !r.endsWith('/broken')), [], 'known tags come from the cache');

  // The registry is down: the listing says so instead of throwing
  server.close();
  const down = await listPublished(cfg, quiet, { registry: 'localhost:1', repository: 'fnkc-stats/r-env' });
  assert.match(down.error!, /^cannot read localhost:1\/fnkc-stats\/r-env: /);
  assert.deepEqual(down.images, []);
});

test("the templates' pins are read from git like a project's, and kept when Gitea is unreachable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-templates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
  const bare = join(dir, 'gitea', 'stats', 'template-r-4.6.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare');
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) git(bare, 'config', k, v);
  const work = join(dir, 'work');
  mkdirSync(work);
  git(work, 'init', '-q');
  writeFileSync(join(work, 'container.json'), JSON.stringify({ image: `${REPO}@${sha('1')}` }));
  git(work, 'add', '.');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'template');
  git(work, 'push', '-q', bare, 'HEAD:refs/heads/main');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  // Gitea's address leads to the directory above
  const env = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${join(dir, 'gitea', 'stats')}/.insteadOf`, GIT_CONFIG_VALUE_0: 'ssh://git@gitea.test/stats/',
    GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always' };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; Object.assign(process.env, saved); });
  const cfg = clientConfig({ cacheDir: join(dir, 'cache'), gitRemotes: ['ssh://git@gitea.test/stats'] });

  const pins = await templatePins(cfg, ['4.6', '4.5'], 'template-r-{series}', quiet);
  assert.deepEqual(pins[0], { series: '4.6', repository: 'template-r-4.6', image: `${REPO}@${sha('1')}`, stale: undefined });
  assert.equal(pins[1].repository, 'template-r-4.5');
  assert.match(pins[1].error!, /not found or unreachable in Gitea/);

  rmSync(bare, { recursive: true, force: true });
  const offline = await templatePins(cfg, ['4.6'], 'template-r-{series}', quiet);
  assert.equal(offline[0].image, `${REPO}@${sha('1')}`);
  assert.equal(offline[0].stale, true);

  assert.match((await templatePins(clientConfig({}), ['4.6'], 'template-r-{series}', quiet))[0].error!, /gitRemotes is not set/);
  await assert.rejects(templatePins(cfg, ['4.6'], 'template', quiet), /must contain \{series\}/);
});

class ImagesDocker extends Docker {
  imgs: ImageJson[] = [];
  cs: ContainerJson[] = [];
  removed: string[] = [];
  override async images() { return this.imgs; }
  override async containers(_labels: string[]) { return this.cs; }
  override async image(ref: string) { return this.imgs.find((i) => i.Id === ref) ?? null; }
  override async run(args: string[], _opts?: RunOptions) {
    if (args[0] === 'image' && args[1] === 'rm') {
      this.removed.push(args[2]);
      const img = this.imgs.find((i) => i.RepoTags?.includes(args[2]) || i.RepoDigests?.includes(args[2]));
      if (img) {
        img.RepoTags = img.RepoTags?.filter((x) => x !== args[2]);
        img.RepoDigests = img.RepoDigests?.filter((x) => x !== args[2]);
        if (!img.RepoTags?.length && !img.RepoDigests?.length) this.imgs = this.imgs.filter((i) => i !== img);
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  override async ok(_args: string[], _opts?: RunOptions) { return ''; }
}

const container = (name: string, image: string, user: string, project: string, running: boolean): ContainerJson => ({
  Name: `/${name}`, Image: image, Config: { Image: 'x', Env: [], Labels: { 'fnkc.managed': '1', 'fnkc.user': user, 'fnkc.project': project } },
  State: { Running: running, Status: running ? 'running' : 'exited' }, NetworkSettings: { Ports: null },
});

test('agent images: environment images only, their pins, and the containers of all users counted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-agent-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = new ImagesDocker();
  const labels = { 'r-env.r-version': '4.6.2', 'positron.version': '2026.11.1-4', 'org.opencontainers.image.vendor': 'Rocker Project' };
  docker.imgs = [
    { Id: sha('1'), Architecture: 'amd64', RepoDigests: [`${REPO}@${sha('a')}`], RepoTags: [], Size: 1.6e9, Created: '2026-11-19T22:58:39Z', Config: { Labels: labels } },
    { Id: sha('2'), Architecture: 'amd64', RepoTags: [`${REPO}:sha256-${hex('b')}`], Size: 1.5e9, Created: '2026-11-10T00:00:00Z', Config: { Labels: null } },
    { Id: sha('3'), Architecture: 'amd64', RepoTags: ['postgres:16'], Size: 4e8, Config: { Labels: null } },
    { Id: sha('4'), Architecture: 'amd64', RepoTags: ['ghcr.io/evil/r-env:sha256-' + hex('c')], Size: 1, Config: { Labels: null } },
  ];
  docker.cs = [
    container('fnkc-alice-thesis', sha('1'), 'alice', 'thesis', true),
    container('fnkc-bob-secret', sha('1'), 'bob', 'secret', false),
    container('fnkc-bob-secret-previous', sha('1'), 'bob', 'secret', false),
  ];
  const agent = new Agent(agentConfig('alice', { lockDir: dir }), quiet, docker);
  const list = await handle(agent, ['images'], async () => '') as HostImage[];
  assert.deepEqual(list.map((i) => i.id), [sha('1'), sha('2')]);
  assert.deepEqual(list[0], {
    references: [`${REPO}@${sha('a')}`], id: sha('1'), architecture: 'amd64', size: 1.6e9, created: '2026-11-19T22:58:39Z',
    labels: { 'r-env.r-version': '4.6.2', 'positron.version': '2026.11.1-4' }, containers: 2, running: 1, projects: ['thesis'],
  });
  assert.ok(!JSON.stringify(list).includes('secret'), "other users' project names stay private");
  assert.deepEqual(list[1].references, [`${REPO}@${sha('b')}`]);
  await assert.rejects(handle(agent, ['images', 'x'], async () => ''), /too many arguments/);

  // Removing: only an environment image no container uses, each of its names without force
  await assert.rejects(agent.removeImage(sha('1')), /used by fnkc-alice-thesis, fnkc-bob-secret/);
  await assert.rejects(agent.removeImage(sha('3')), /only environment images/);
  await assert.rejects(agent.removeImage('postgres:16'), /not an image ID/);
  await agent.removeImage(sha('2'));
  assert.deepEqual(docker.removed, [`${REPO}:sha256-${hex('b')}`]);
  assert.ok(!docker.imgs.some((i) => i.Id === sha('2')));
});

test('pins of a host image: pulled by digest, or uploaded under its sha256- tag', () => {
  assert.deepEqual(pinsOf({ RepoDigests: [`${REPO}@${sha('a')}`, `docker.io/x@${sha('b')}`], RepoTags: [`${REPO}:sha256-${hex('c')}`, `${REPO}:latest`] }, [REPO]),
    [`${REPO}@${sha('a')}`, `${REPO}@${sha('c')}`]);
  assert.deepEqual(pinsOf({ RepoTags: null, RepoDigests: null }, [REPO]), []);
});

// ---- The overview and the panel, from made-up sources ----

const D = 'd'.repeat(40);
const TEAM = '2026.11.1-4';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const env = (series: string, commit: string, run: number, digestChar: string, created: string): PublishedImage => {
  const tag = `${series}-env-${commit}-${run}-1`;
  return { ...parseTag(tag), tag, digest: sha(digestChar), reference: `${REPO}@${sha(digestChar)}`, architectures: ['amd64', 'arm64'], size: 1.7e9, created,
    labels: { 'r-env.r-series': series, 'r-env.r-version': series === '4.6' ? '4.6.2' : '4.5.3' } };
};
/** The server of `positron` on the environment with digest sha(baseChar). */
const layer = (positron: string, baseChar: string, digestChar: string, created: string): PublishedImage => {
  const tag = `positron-${positron}-${hex(baseChar)}`;
  return { ...parseTag(tag), tag, digest: sha(digestChar), reference: `${REPO}@${sha(digestChar)}`, architectures: ['amd64', 'arm64'], size: 1.8e9, created,
    labels: { 'r-env.r-series': '4.6', 'r-env.r-version': '4.6.2', 'positron.version': positron, 'r-env.base': `${REPO}@${sha(baseChar)}` } };
};

function sample() {
  const legacyTag = `4.6-${A}-50-1`;
  const registry: RegistryListing = { repository: REPO, problems: [], images: [ // newest first, as listPublished gives them
    env('4.6', C, 300, 'c', '2026-11-20T10:00:00Z'),
    layer(TEAM, 'c', 'd', '2026-11-20T10:30:00Z'),
    layer('2026.07.1-5', 'c', 'e', '2026-11-20T11:00:00Z'),
    env('4.6', B, 200, 'b', '2026-11-19T10:00:00Z'),
    layer(TEAM, 'b', '7', '2026-11-19T10:30:00Z'),
    env('4.6', A, 100, 'a', '2026-11-18T10:00:00Z'),
    layer(TEAM, 'a', '8', '2026-11-18T10:30:00Z'),
    env('4.5', A, 100, '5', '2026-11-18T10:00:00Z'),
    env('4.6', D, 90, '0', '2026-09-01T10:00:00Z'),
    layer(TEAM, '0', '3', '2026-09-01T10:30:00Z'),
    layer('2026.06.1-6', 'b', '2', '2026-09-01T10:00:00Z'),
    { ...parseTag(legacyTag), tag: legacyTag, digest: sha('6'), reference: `${REPO}@${sha('6')}`, architectures: ['amd64'], created: '2026-09-01T09:00:00Z',
      labels: { 'r-env.r-series': '4.6', 'r-env.r-version': '4.6.1', 'positron.version': '2026.08.0-1' }, archTags: [`${legacyTag}-amd64`] },
    layer(TEAM, 'f', '4', '2026-09-01T08:00:00Z'),
  ] };
  const templates = [
    { series: '4.6', repository: 'template-r-4.6', image: `${REPO}@${sha('b')}` },
    { series: '4.5', repository: 'template-r-4.5', image: `${REPO}@${sha('5')}` },
  ];
  const hostImage = (id: string, ref: string, base: string | undefined, containers: number, running: number, projects: string[] = []): HostImage => ({
    references: [ref], id: sha(id), architecture: 'amd64', size: 1.6e9, created: '2026-11-18T10:00:00Z',
    labels: { 'r-env.r-version': '4.6.2', 'positron.version': TEAM, ...(base ? { 'r-env.base': base } : {}) }, containers, running, projects });
  const hosts: HostImages[] = [
    { host: 'server', ssh: 'fnkc@stats.lan', images: [hostImage('1', `${REPO}@${sha('8')}`, `${REPO}@${sha('a')}`, 3, 1, ['thesis']), hostImage('2', `${REPO}@${sha('9')}`, undefined, 0, 0)] },
    { host: 'local', images: [hostImage('3', `${REPO}:sha256-${hex('7')}`, `${REPO}@${sha('b')}`, 0, 0)] },
    { host: 'old', ssh: 'fnkc@old.lan', images: [], error: "'old' runs an older fnkc-ctl", older: true },
  ];
  // The user's own containers run the server image; on a host without registry access it is the uploaded tag
  const projects = [{ host: 'server', containers: [{ project: 'thesis', container: 'c', running: true, state: 'running', image: `${REPO}:sha256-${hex('8')}` }] }];
  return overview(registry, templates, hosts, projects, undefined, { teamPositron: TEAM, now: NOW });
}

test('the overview: environments with their Positron servers, joined with templates and hosts by digest', () => {
  const o = sample();
  assert.deepEqual(o.series.map((g) => [g.series, g.templateState]), [['4.6', 'older'], ['4.5', 'newest']]);
  const rows = o.series[0].rows;
  assert.deepEqual(rows.map((r) => [r.kind, r.digest.slice(7, 8), r.newest, r.unused]), [
    ['environment', 'c', true, false],
    ['environment', 'b', false, false],
    ['environment', 'a', false, false],
    ['environment', '0', false, true],
    ['legacy', '6', false, true],
  ], 'environments first, newest first; an image with the server built in is not "newest" once the series has environments');
  const [c, b, a, old] = rows;
  assert.deepEqual(c.layers.map((l) => [l.positron, l.unused]), [['2026.11.1-4', false], ['2026.07.1-5', false]], 'newest Positron first; a new layer for another Positron is kept');
  assert.deepEqual(b.layers.map((l) => [l.positron, l.unused]), [['2026.11.1-4', false], ['2026.06.1-6', true]], 'an old layer for a Positron the team left is unused');
  assert.deepEqual(old.layers.map((l) => l.unused), [true], 'the layers of an unused environment are unused');
  assert.deepEqual(b.templates, ['template-r-4.6']);
  assert.deepEqual(b.hosts, [{ host: 'local', containers: 0, running: 0 }], 'a host that has its layer has the environment');
  assert.deepEqual(a.hosts, [{ host: 'server', containers: 3, running: 1 }]);
  assert.deepEqual(a.projects, [{ host: 'server', project: 'thesis' }]);
  assert.deepEqual(o.series[0].orphans.map((l) => [l.digest.slice(7, 8), l.unused]), [['4', true]]);
  assert.deepEqual(o.unchecked, ['old']);
  const [server, local] = o.hosts;
  assert.equal(server.rows[0].published?.kind, 'positron');
  assert.equal(server.rows[1].published, undefined);
  assert.deepEqual(local.rows[0].templates, ['template-r-4.6'], "a layer on a host is the template's when the template pins its environment");
  assert.equal(server.size, 3.2e9);

  // A template pinning a digest the registry does not have
  const o3 = overview(o.registry, [{ series: '4.6', repository: 't', image: `${REPO}@${sha('f')}` }], [], []);
  assert.equal(o3.series[0].templateState, 'not-published');
  assert.equal(removalCommand(o.hosts[0], o.hosts[0].rows[1]), `sudo docker image rm ${sha('2')}`);
  assert.equal(removalCommand(o.hosts[1], o.hosts[1].rows[0]), `docker image rm ${sha('3')}`);
  const text = overviewText(o);
  assert.match(text, /\(team Positron 2026\.11\.1-4\)/);
  assert.match(text, /R 4\.6 {3}template template-r-4\.6: pins an older environment/);
  assert.match(text, / {6}Positron 2026\.07\.1-5 +2026-11-20/);
  assert.match(text, /On old: 'old' runs an older fnkc-ctl/);
});

test('cleanup: unused and old enough, an environment with its servers, never what is kept, pinned or used', () => {
  const o = sample();
  const plan = cleanupPlan(o, { now: NOW });
  assert.deepEqual(plan.removals.map((r) => [r.digest.slice(7, 8), r.reason]), [
    ['2', "not the team's Positron (2026.11.1-4), unused"],
    ['0', 'not the newest, not pinned, unused'],
    ['3', 'its environment goes'],
    ['6', 'server built in (from before environments), unused'],
    ['4', 'its environment is not in the registry'],
  ]);
  assert.deepEqual(plan.removals.find((r) => r.digest === sha('6'))?.tags, [`4.6-${A}-50-1`, `4.6-${A}-50-1-amd64`], 'with the tags of its architectures');
  assert.deepEqual(plan.blockers, ['the containers on old could not be counted']);
  assert.match(cleanupText(plan), /Not safe to apply now:\n {2}the containers on old could not be counted/);
  // Pins of projects (--keep) protect an environment and the team's server on it
  const keep = digestsIn(`thesis/container.json: "image": "${REPO}@${sha('0')}"`);
  assert.deepEqual(cleanupPlan(o, { now: NOW, keep }).removals.map((r) => r.digest.slice(7, 8)), ['2', '6', '4']);
  // Younger than --older-than: nothing goes
  assert.deepEqual(cleanupPlan(o, { now: NOW, olderThanDays: 365 }).removals, []);
});

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
type Menu = { command: string; when: string; group?: string };
/** The commands package.json shows on a tree item with this context value (inline: the buttons on its line). */
function menuOf(contextValue: string | undefined, inline: boolean): string[] {
  return (manifest.contributes.menus['view/item/context'] as Menu[]).filter((m) => {
    if (!m.when.includes('view == fnkcProjects.images') || (m.group?.startsWith('inline') ?? false) !== inline) return false;
    const re = /viewItem =~ \/(.+?)\/(?: |$)/.exec(m.when)?.[1];
    return contextValue !== undefined && re !== undefined && new RegExp(re).test(contextValue);
  }).map((m) => m.command.replace('fnkcProjects.images.', ''));
}

test('the panel: words, icons and the buttons on each line', async () => {
  const o = sample();
  const tree = new ImagesTree(async () => o, () => ({ envRepository: 'fnkc-stats/positron-remote', positron: '2026.07.1-5' }));
  let loaded = 0;
  tree.onLoaded = () => { loaded++; };
  type Shown = { label: string; description?: string; contextValue?: string; icon?: string; tooltip: string; children: Shown[] };
  const walk = async (item?: ImageItem): Promise<Shown[]> => Promise.all((await tree.getChildren(item)).map(async (c) => {
    const t = tree.getTreeItem(c) as unknown as { label: string; description?: string; contextValue?: string; iconPath?: { id: string }; tooltip?: string | { value: string } };
    return { label: t.label, description: t.description, contextValue: t.contextValue, icon: t.iconPath?.id,
      tooltip: typeof t.tooltip === 'string' ? t.tooltip : t.tooltip?.value ?? '', children: await walk(c) };
  }));
  const shown = await walk();
  assert.equal(loaded, 1);
  assert.deepEqual(shown.map((s) => [s.label, s.description]), [
    ['Published', REPO],
    ['server', '2 images · 3.2 GB · 1 unused'],
    ['local', '1 image · 1.6 GB · 1 unused'],
    ['old', 'update fnkc-ctl on the server to list its images'],
  ]);
  const [r46, r45] = shown[0].children;
  assert.deepEqual([r46.label, r46.description, r46.icon], ['R 4.6', 'template pins an older environment', 'warning']);
  assert.match(r46.tooltip, /copy the newest pin/);
  assert.deepEqual([r45.label, r45.description], ['R 4.5', 'template is up to date']);
  assert.deepEqual(r46.children.map((c) => [c.label, c.description]), [
    ['2026-11-20 · ccccccc', 'newest · Positron 2026.11.1-4, 2026.07.1-5'],
    ['2026-11-19 · bbbbbbb', 'Positron 2026.11.1-4, 2026.06.1-6 · template · on local · none for your 2026.07.1-5'],
    ['2026-11-18 · aaaaaaa', 'Positron 2026.11.1-4 · 3 containers · on server · none for your 2026.07.1-5'],
    ['2026-09-01 · ddddddd', 'Positron 2026.11.1-4 · unused · none for your 2026.07.1-5'],
    ['2026-09-01 · aaaaaaa', 'server built in · unused'],
    ['Positron 2026.11.1-4', '2026-09-01 · environment not in the registry · unused'],
  ]);
  const [newest, tpl, used] = r46.children;
  assert.deepEqual(newest.children.map((c) => [c.label, c.description, c.icon]), [
    ['Positron 2026.11.1-4', '2026-11-20', 'server-process'], ['Positron 2026.07.1-5', '2026-11-20', 'server-process']]);
  assert.deepEqual(tpl.children.map((c) => [c.label, c.icon]), [['Positron 2026.11.1-4', 'server-process'], ['Positron 2026.06.1-6', 'circle-outline']]);
  assert.equal(tpl.icon, 'star-full');
  assert.match(tpl.tooltip, /after \*\*Build Environment\*\* adds its server/);
  assert.match(used.tooltip, /CI run 100\]\(https:\/\/github\.com\/fnkc-stats\/positron-remote\/actions\/runs\/100\)/);
  assert.match(used.children[0].tooltip, /on \*\*server\*\*: 3 project containers \(1 running\)/);

  // Buttons on each line, and the right-click menu
  assert.deepEqual(menuOf(newest.contextValue, true), ['copyPin', 'openPackages']);
  assert.deepEqual(menuOf(newest.contextValue, false), ['copyPin', 'pinHere', 'openPackages', 'openRun', 'openCommit']);
  assert.ok(menuOf(used.contextValue, false).includes('compare'));
  assert.deepEqual(menuOf(newest.children[0].contextValue, true), [], 'a server layer is not something to pin');
  assert.deepEqual(menuOf(r46.contextValue, true), ['copyPin'], 'the series line copies its newest pin');
  for (const host of shown.slice(1)) assert.deepEqual(menuOf(host.contextValue, true), [], `no image buttons on host ${host.label}`);
  const [serverUsed, serverUnused] = shown[1].children;
  assert.deepEqual([serverUnused.label, serverUnused.icon], ['2026-11-18 · not in the registry', 'circle-outline']);
  assert.deepEqual(menuOf(serverUnused.contextValue, true), ['copyPin', 'copyRemoval'], 'a server image is removed by its administrator');
  assert.ok(menuOf(serverUsed.contextValue, true).includes('copyPin'));
  assert.equal(serverUsed.label, '2026-11-18 · Positron 2026.11.1-4 server');
  assert.ok(menuOf(shown[2].children[0].contextValue, true).includes('remove'), 'an image on this computer can be removed here');
  assert.match(shown[2].children[0].description!, /R 4\.6\.2 · Positron 2026\.11\.1-4 · 1\.6 GB · template · unused/);

  // A failed load is one line that says so, never an exception
  const broken = new ImagesTree(async () => { throw new Error('config: "hosts" must be a non-empty list'); }, () => ({ envRepository: 'x/y' }));
  const lines = await broken.getChildren();
  assert.equal(lines.length, 1);
  assert.equal((broken.getTreeItem(lines[0]) as unknown as { tooltip: string }).tooltip, 'config: "hosts" must be a non-empty list');
});

test('a server with the fnkc-ctl from before images is shown as such, not as an error', async (t) => {
  const { chmodSync } = await import('node:fs');
  const { delimiter } = await import('node:path');
  const { listHostImages } = await import('../src/client/images.ts');
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-old-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // What fnkc-ctl 0.3.0 answers to "agent images"
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\necho '{"ok":false,"error":"unknown agent command: '"'"'images'"'"' (ping, list, stop <project>, start, install-image <image>)"}'\nexit 1\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });
  const [h] = await listHostImages(clientConfig({ hosts: [{ name: 'server', ssh: 'fnkc@stats.lan' }], cacheDir: dir }), quiet);
  assert.equal(h.older, true);
  assert.equal(h.error, "'server' runs an older fnkc-ctl that cannot list its images; they appear here after the server update");
  const tree = new ImagesTree(async () => overview({ repository: REPO, images: [], problems: [] }, [], [h], []), () => ({ envRepository: 'x/y' }));
  const [, host] = await tree.getChildren();
  assert.equal((tree.getTreeItem(host) as unknown as { description: string }).description, 'update fnkc-ctl on the server to list its images');
});
