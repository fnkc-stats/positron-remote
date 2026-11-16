// Scripts copied into every project container. The build embeds them (esbuild --loader:.sh=text),
// so positron-ctl is a single file both on servers and inside the extension.
import entrypoint from '../container/entrypoint.sh';
import idleWatch from '../container/idle-watch.sh';
import projects from '../container/positron-projects.sh';

export const ENTRYPOINT: string = entrypoint;
export const PROJECTS_SCRIPT: string = projects;
export const IDLE_WATCH: string = idleWatch;
