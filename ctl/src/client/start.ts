// Starting a project's container on a host: which image to ask for, and what Open does when the host answers that it
// lacks the image, that the checkout pins another environment, or that it refuses the image's provenance. Every effect
// comes in through StartDeps, so the tests drive each branch with fakes (test/start.test.ts); openProject (open.ts)
// passes the real ones.
import { CheckoutPinsOther, EnvironmentImageMissing } from '../image-store.ts';
import { ImageRejected, ProvenanceRefused } from '../errors.ts';
import { Cancelled, throwIfCancelled } from '../exec.ts';
import type { Logger } from '../log.ts';
import type { CheckoutState, ImageMissing, StartRequest, StartResult } from '../protocol.ts';
import { type ImageUpload, RegistryHttpError } from './image-download.ts';
import { NoProvenance, type ProvenanceProof } from './provenance.ts';

export interface StartDeps {
  /** The host (Transport.start, installImage, requiresProvenance). */
  start(req: StartRequest): Promise<StartResult>;
  installImage(m: ImageMissing, u: ImageUpload): Promise<unknown>;
  /** The project's checkout on the host (Transport.checkout); absent where the host cannot answer (older server). */
  checkout?(): Promise<CheckoutState>;
  /**
   * The pin and commit of remote HEAD (readProjectRevision: Gitea, else this computer's last copy), read only when
   * the host has no checkout to adopt, so a warm host opens while Gitea is down. Absent: the request's are used.
   */
  remoteHead?(): Promise<{ image: string; revision: string }>;
  /** Remote HEAD will not be read: the checkout on the host was adopted. Its reading, if under way, can stop. */
  remoteHeadUnneeded?(): void;
  requiresProvenance: boolean;
  /** The image with the server of the user's Positron for a pinned environment (variant.ts); undefined: run the pin. */
  imageToRun(pinned: string): Promise<{ image: string } | undefined>;
  /** Forgets the choice imageToRun cached for this pin, so the next call looks in the registry again. */
  forgetChoice(pinned: string): void;
  /** The image's attestation, cached on this computer (provenance.ts). */
  provenanceProof(image: string): Promise<ProvenanceProof>;
  forgetProof(image: string): void;
  /** This computer's download of an image the host lacks (image-download.ts), and its cache. */
  imageUpload(m: ImageMissing): Promise<ImageUpload>;
  forgetImage(u: ImageUpload): void;
  /** Trims the download cache, keeping `keep`; returns the bytes freed. */
  pruneImageCache(keep: ImageUpload): number;
  log: Logger;
  signal?: AbortSignal;
}

/**
 * How often one Open acts on each kind of reply it can recover from. One more of the same kind fails the Open with
 * that reply. An image is uploaded once per image: a host that still lacks it after the upload fails the Open.
 *   registryGone: the server image chosen at an earlier Open is no longer in the registry: choose again
 *   checkoutPins: the checkout on the host pins another environment: choose for that one
 *   proofRefetch: the host refused the cached provenance: fetch it again from GitHub
 */
export const START_BUDGET = { registryGone: 1, checkoutPins: 1, proofRefetch: 1 } as const;
type Retry = keyof typeof START_BUDGET;

/**
 * The user cancelled Open while the environment image was downloading to this computer or being sent to the host:
 * what arrived stays in the download cache, so opening again on the same host (`host`, set by openProject) continues.
 */
export class TransferCancelled extends Cancelled {
  readonly image: string;
  readonly host?: string;
  constructor(image: string, host?: string) { super(); this.image = image; this.host = host; }
}

/** A start request before its environment and commit are known: the checkout on the host's, else remote HEAD's. */
export type OpenStart = Omit<StartRequest, 'image' | 'revision'> & Partial<Pick<StartRequest, 'image' | 'revision'>>;

/**
 * Starts the container for `open`, retrying after the replies above. Its `image` and `revision` are the existing
 * checkout's on the host, else remote HEAD's (deps.remoteHead, or the ones given). Fills in positronImage and the
 * provenance proof; returns what the host started.
 */
export async function resolveStart(deps: StartDeps, open: OpenStart): Promise<StartResult> {
  const used: Record<Retry, number> = { registryGone: 0, checkoutPins: 0, proofRefetch: 0 };
  const spend = (kind: Retry, e: unknown) => {
    if (used[kind] >= START_BUDGET[kind]) throw e;
    used[kind]++;
  };
  const uploaded = new Set<string>();
  if (await adoptCheckout(deps, open)) deps.remoteHeadUnneeded?.();
  else if (deps.remoteHead) Object.assign(open, await deps.remoteHead());
  if (!open.image || !open.revision) throw new Error('resolveStart: no environment or commit to start');
  const request = open as StartRequest;
  await choose(deps, request, request.image);
  for (;;) {
    throwIfCancelled(deps.signal);
    try {
      return await deps.start(request);
    } catch (e) {
      if (e instanceof EnvironmentImageMissing) {
        if (uploaded.has(e.missing.image)) throw e;
        let upload: ImageUpload;
        try {
          upload = await deps.imageUpload(e.missing);
        } catch (err) {
          if (err instanceof Cancelled) throw new TransferCancelled(e.missing.image);
          // The server image chosen at an earlier Open was removed from the registry since: look for it again
          // (a rebuilt one, or NoPositronImage, which offers Build Environment)
          if (request.positronImage?.image !== e.missing.image || !(err instanceof RegistryHttpError) || err.status !== 404) throw err;
          spend('registryGone', err);
          deps.log.info(`${e.missing.image} is no longer in the registry; looking for the server of this Positron again`);
          deps.forgetChoice(request.image);
          await choose(deps, request, request.image);
          continue;
        }
        try {
          await deps.installImage(e.missing, upload);
        } catch (err) {
          if (err instanceof Cancelled) throw new TransferCancelled(e.missing.image);
          // Only content the host rejected is downloaded again; an interrupted upload reuses the cache
          if (err instanceof ImageRejected) deps.forgetImage(upload);
          throw err;
        }
        uploaded.add(e.missing.image);
        const freed = deps.pruneImageCache(upload);
        if (freed) deps.log.info(`Removed ${Math.round(freed / 1e6)} MB of older images from this computer's download cache`);
      } else if (e instanceof ProvenanceRefused && request.provenanceBundle) {
        // A cached proof can be stale (fetched under another policy, or before the right attestation existed):
        // fetch it once more from GitHub
        spend('proofRefetch', e);
        const img = request.positronImage?.image ?? request.image;
        deps.log.warn(`the host refused the cached provenance of ${img}; fetching it again`);
        deps.forgetProof(img);
        try {
          attach(request, await deps.provenanceProof(img));
        } catch {
          throw e;
        }
      } else if (e instanceof CheckoutPinsOther) {
        spend('checkoutPins', e);
        deps.log.info(`The checkout pins ${e.pinned}`);
        await choose(deps, request, e.pinned);
      } else throw e;
    }
  }
}

/**
 * The checkout on the host takes precedence over remote HEAD (docs/lifecycle.md): Open runs the environment it pins,
 * even when remote HEAD pins one that has no server of this Positron, and without reading remote HEAD at all (Gitea
 * may be down). Advisory: the start checks it again under its lock. Returns whether the checkout was adopted.
 */
async function adoptCheckout(deps: StartDeps, request: OpenStart): Promise<boolean> {
  if (!deps.checkout) return false;
  let s: CheckoutState;
  try {
    s = await deps.checkout();
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    deps.log.info(`Could not ask the host about an existing checkout (${(e as Error).message}); choosing for remote HEAD`);
    return false;
  }
  if (s.checkout === 'unknown') deps.log.info(`Could not read the existing checkout before starting (${s.reason ?? 'no reason given'}); choosing for remote HEAD`);
  // Another repository's checkout: the start refuses it and says so
  if (s.checkout !== 'present' || !s.image || !s.revision || s.repository !== request.repository.replace(/\/+$/, '')) return false;
  if (!request.image) deps.log.info(`The checkout on the host pins ${s.image}; opening it as it is`);
  else if (s.image !== request.image) deps.log.info(`The checkout on the host pins ${s.image} (remote HEAD: ${request.image}); opening it as it is`);
  request.image = s.image;
  request.revision = s.revision;
  return true;
}

function attach(request: StartRequest, proof: ProvenanceProof) {
  request.provenanceBundle = proof.bundle;
  request.provenanceSubject = proof.subject;
}

/** Sets the request up for the environment `pinned`: the image to run with this Positron, and its proof. */
async function choose(deps: StartDeps, request: StartRequest, pinned: string): Promise<void> {
  request.image = pinned;
  let run = await deps.imageToRun(pinned);
  if (run) request.positronImage = run; else delete request.positronImage;
  delete request.provenanceBundle; delete request.provenanceSubject;
  if (!deps.requiresProvenance) return;
  try {
    attach(request, await deps.provenanceProof(run?.image ?? pinned));
  } catch (e) {
    if (!(e instanceof NoProvenance)) {
      // GitHub or the registry unreachable: a host that verified this image before, or a running project, needs no proof
      deps.log.warn(`could not fetch the image's provenance (${(e as Error).message}); the host starts it only if it verified it before`);
      return;
    }
    if (!run) throw e;
    // A forced rebuild can replace the Positron tag. Refresh the cached digest once if its old digest has no proof.
    deps.forgetChoice(pinned);
    const refreshed = await deps.imageToRun(pinned);
    if (!refreshed || refreshed.image === run.image) {
      throw new Error(`${e.message}; rebuild this environment with FNKC Projects: Build Environment`);
    }
    run = refreshed;
    request.positronImage = run;
    attach(request, await deps.provenanceProof(run.image));
  }
}
