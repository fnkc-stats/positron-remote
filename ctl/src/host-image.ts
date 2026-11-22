// The image a host tool outside the agent may run against private files (volume-backup.sh: `tar` over a project
// volume or a restore stream), resolved to Docker's immutable image ID. A name is not enough: the tag of an uploaded
// image (repository:sha256-<hex>) can be moved to any image during maintenance. The checks are the host's own:
//   - the repository is in allowedImages;
//   - with requireProvenance, the digest passed provenance verification on this host under the current policy
//     (there is no client to send a proof: open a project with the image first);
//   - the local image is the one the digest names: pulled, Docker resolves repository@digest itself; uploaded, the
//     tag must still point at the image ID recorded when the agent loaded the checked upload (image-store.ts).
// Both names present for different images, a missing record or a moved tag are refused, not guessed.
import type { AgentConfig } from './agent-config.ts';
import type { Docker } from './docker.ts';
import { loadedImageId } from './image-store.ts';
import { parseReference, uploadedTag } from './oci.ts';
import { provenanceVerified } from './provenance.ts';
import { checkImage } from './validate.ts';

const ID = /^sha256:[0-9a-f]{64}$/;

export async function resolveHostImage(
  cfg: AgentConfig, docker: Pick<Docker, 'image'>, imageArg: string,
): Promise<string> {
  const image = checkImage(imageArg, cfg.allowedImages);
  const name = image.split('@')[0].replace(/:[^/:]+$/, '');
  const { digest } = parseReference(image);
  const pinned = `${name}@${digest}`;
  if (cfg.requireProvenance && !provenanceVerified(cfg, image)) {
    throw new Error(`${image} has not passed provenance verification on this host; use an image a project here was opened with`);
  }
  const pulled = await docker.image(pinned);
  if (pulled && !(pulled.RepoDigests ?? []).includes(pinned)) throw new Error(`Docker's image for ${pinned} does not carry that digest; refusing it`);
  const tag = uploadedTag(image);
  const uploaded = await docker.image(tag);
  const recorded = loadedImageId(cfg.imageStagingDir, image);
  if (pulled && uploaded && pulled.Id !== uploaded.Id) {
    throw new Error(`${tag} names another image than ${pinned}; remove the stale tag (docker image rm ${tag}) after inspecting it`);
  }
  if (pulled) {
    if (!ID.test(pulled.Id)) throw new Error(`unexpected image ID for ${pinned}: ${pulled.Id}`);
    return pulled.Id;
  }
  if (!uploaded) throw new Error(`image not on this host: ${image} (open a project that pins it first)`);
  if (!recorded) {
    throw new Error(`no record of the upload of ${image} on this host (loaded by an older fnkc-ctl or by hand): its tag ${tag} cannot be ` +
      `trusted. Pull it by digest (docker pull ${pinned}) or use an image uploaded since the update`);
  }
  if (uploaded.Id !== recorded) {
    throw new Error(`${tag} now names ${uploaded.Id}, not the image ${recorded} that was uploaded for ${image}; refusing it`);
  }
  return recorded;
}
