// The image a host tool outside the agent may run against private files (volume-backup.sh: `tar` over a project
// volume or a restore stream; render-reviewed.py: a render over real data), resolved to Docker's immutable image ID.
// A name is not enough: the tag of an uploaded image (repository:sha256-<hex>) can be moved to any image during
// maintenance. The checks are the host's own:
//   - the repository is in allowedImages;
//   - with requireProvenance, the digest passed provenance verification on this host under the current policy
//     (there is no client to send a proof: open a project with the image first);
//   - the local image is the one the digest names (imageOnHost, the same check project starts make): pulled, Docker
//     resolves repository@digest itself; uploaded, the tag must still point at the image ID recorded when the agent
//     loaded the checked upload (image-store.ts).
// A missing or damaged record or a moved tag is refused, not guessed; with both names for different images the pulled one is used.
import type { AgentConfig } from './agent-config.ts';
import type { Docker } from './docker.ts';
import { imageOnHost, loadedRecord } from './image-store.ts';
import { parseReference, uploadedTag } from './oci.ts';
import { provenanceVerified } from './provenance.ts';
import { checkImage } from './validate.ts';

export async function resolveHostImage(
  cfg: AgentConfig, docker: Pick<Docker, 'image'>, imageArg: string,
): Promise<string> {
  const image = checkImage(imageArg, cfg.allowedImages);
  if (cfg.requireProvenance && !provenanceVerified(cfg, image)) {
    throw new Error(`${image} has not passed provenance verification on this host; use an image a project here was opened with`);
  }
  const have = await imageOnHost(docker, cfg.imageStagingDir, image);
  switch (have.state) {
    case 'ready': return have.id;
    case 'absent': throw new Error(`image not on this host: ${image} (open a project that pins it first)`);
    case 'unrecorded': {
      const pinned = `${image.split('@')[0].replace(/:[^/:]+$/, '')}@${parseReference(image).digest}`;
      throw new Error(`no record of the upload of ${image} on this host (loaded by an older fnkc-ctl or by hand): its tag ${uploadedTag(image)} cannot be ` +
        `trusted. Pull it by digest (docker pull ${pinned}) or use an image uploaded since the update`);
    }
    case 'invalid': throw new Error(`the record of the upload of ${image} on this host (${loadedRecord(cfg.imageStagingDir, image)}) names no image ID: ` +
      `its tag ${have.tag} cannot be trusted. Remove the tag (docker image rm ${have.tag}) and open a project with the image to upload it again`);
    case 'moved': throw new Error(`${have.tag} now names ${have.id}, not the image ${have.recorded} that was uploaded for ${image}; refusing it`);
  }
}
