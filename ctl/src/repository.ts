import { createHash } from 'node:crypto';
import { checkProject } from './validate.ts';

/** Only SSH and HTTPS repositories: no git helpers, local paths, credentials, or shell metacharacters. */
export function checkRepository(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d+)?\/|https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)[A-Za-z0-9_./-]+$/.test(value)) {
    throw new Error('repository must be an SSH or HTTPS URL without embedded credentials or shell syntax');
  }
  if (value.split('/').includes('..')) throw new Error('repository path cannot contain ..');
  return value.replace(/\/+$/, '');
}

export function repositoryId(url: string): string {
  const valid = checkRepository(url);
  const name = checkProject(valid.split(/[/:]/).pop()!.replace(/\.git$/, ''));
  return `${name.slice(0, 45)}-${createHash('sha256').update(valid.replace(/\.git$/, '')).digest('hex').slice(0, 12)}`;
}

export function manifestImage(text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('image' in value) || typeof value.image !== 'string') {
    throw new Error('container.json must contain an image digest');
  }
  return value.image;
}
