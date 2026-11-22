import { checkProject } from './validate.ts';

/** Only SSH and HTTPS repositories: no git helpers, local paths, credentials, or shell metacharacters. */
export function checkRepository(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d+)?\/|https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)[A-Za-z0-9_./-]+$/.test(value)) {
    throw new Error('repository must be an SSH or HTTPS URL without embedded credentials or shell syntax');
  }
  if (value.split('/').includes('..')) throw new Error('repository path cannot contain ..');
  return value.replace(/\/+$/, '');
}

/**
 * The project's name: the repository's name in Gitea (the last part of its URL, without .git). Containers, volumes
 * and the folder in the container are named after it, so the projects list shows the names people know. Two
 * repositories with the same name (in different organizations) cannot both be open on a host: the second is refused
 * because its container and checkout belong to the first.
 */
export function repositoryName(url: string): string {
  return checkProject(checkRepository(url).split(/[/:]/).pop()!.replace(/\.git$/, ''));
}

/**
 * Whether two repository URLs name the same repository: the same host and path, whichever form (ssh://, user@host:,
 * https://), port, trailing slash or .git suffix each was written in.
 */
export function sameRepository(a: string, b: string): boolean {
  const key = (url: string) => {
    // scheme://[user@]host[:port]/path, or user@host:path (no port in this form: host:2024/x is owner 2024)
    const m = /^[a-z]+:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(url.trim()) ?? /^[^/@:]+@([^/:]+):(.*)$/.exec(url.trim());
    return m ? `${m[1].toLowerCase()}/${m[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}` : url;
  };
  return key(a) === key(b);
}

export function manifestImage(text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('image' in value) || typeof value.image !== 'string') {
    throw new Error('container.json must contain an image digest');
  }
  return value.image;
}
