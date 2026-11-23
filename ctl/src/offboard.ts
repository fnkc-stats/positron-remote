// Offboarding (`admin remove-user`): all work must be on Gitea before the key goes, because a revoked user can no
// longer push it, and nobody else can (the volumes are the user's; backups are the operator's, not a way to hand work
// over). So the removal inspection of every project of the user runs first; work not on Gitea, or a project the
// inspection could not read, refuses the revocation. --lose-work skips the check: a compromised key must go at once,
// never wait for (or be blocked by) reading volumes; admin remove-project shows the work afterwards.
import type { RemovalCheck } from './protocol.ts';
import { lostWork } from './client/remove.ts';

/** A project whose work is not all on Gitea, or could not be checked: short lines, as in lostWork. */
export interface UnverifiedProject {
  project: string;
  lost: string[];
}

/**
 * Runs the removal inspection (read-only) on each project, one after the other (each under its project lock), and
 * returns the projects that would lose work. An inspection that fails (a running project, a recovery container, a
 * checkout that cannot be read) is never read as "nothing lost".
 */
export async function unverifiedProjects(projects: string[], check: (project: string) => Promise<RemovalCheck>): Promise<UnverifiedProject[]> {
  const found: UnverifiedProject[] = [];
  for (const project of projects) {
    try {
      const lost = lostWork(await check(project));
      if (lost.length) found.push({ project, lost });
    } catch (e) {
      found.push({ project, lost: [`not checked: ${(e as Error).message}`] });
    }
  }
  return found;
}

/** What remove-user prints about them before it refuses; none: all work is on Gitea, the key may go. */
export function offboardingReport(user: string, found: UnverifiedProject[]): { lines: string[]; refusal?: string } {
  if (!found.length) return { lines: [] };
  const lines = [`${user}'s work that is not on Gitea, or could not be checked:`];
  for (const p of found) lines.push(`  ${p.project}: ${p.lost.join('; ')}`);
  lines.push(`Details: fnkc-ctl admin remove-project ${user} <project>`);
  const running = found.some((p) => p.lost.some((l) => /is running: stop it first/.test(l)));
  const refusal = `not revoked: ask ${user} to push the work to Gitea${running ? ` and stop the running projects (or stop them: fnkc-ctl admin stop-all ${user})` : ''}, ` +
    'then run this again; or add --lose-work to revoke at once, without the check';
  return { lines, refusal };
}
