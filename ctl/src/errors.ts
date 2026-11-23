// Errors whose kind crosses the protocol: the agent sends `code` with the message (serve.ts), the client makes the
// same class again (hostError), and callers branch on the class, never on the wording. Server and client run
// different builds during server-first upgrades, so a reworded message must not change what a client does.

export type ErrorCode =
  | 'image-missing' // start: the host lacks the environment image (Reply.imageMissing)
  | 'checkout-pins' // start: the checkout pins another environment (Reply.checkoutPins)
  | 'quota' // start: the user's own limits (projects, memory): stopping a project helps
  | 'capacity' // start: the host's limits: the administrator's matter
  | 'busy' // a lock was not free in time: retrying helps
  | 'incompatible' // client and host builds cannot work together
  | 'unknown-command' // the host's fnkc-ctl predates the command
  | 'image-rejected' // install-image: the uploaded content does not match its digest or size
  | 'provenance-refused' // start: the image's provenance proof did not verify
  | 'replacement-not-ready'; // start: a replacement container runs but does not pass readiness (discard-replacement-v1)

export class CodedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class QuotaExceeded extends CodedError {
  constructor(message: string) { super('quota', message); }
}
export class HostCapacity extends CodedError {
  constructor(message: string) { super('capacity', message); }
}
export class LockBusy extends CodedError {
  constructor(message: string) { super('busy', message); }
}
export class Incompatible extends CodedError {
  constructor(message: string) { super('incompatible', message); }
}
export class UnknownCommand extends CodedError {
  constructor(message: string) { super('unknown-command', message); }
}
export class ImageRejected extends CodedError {
  constructor(message: string) { super('image-rejected', message); }
}
export class ProvenanceRefused extends CodedError {
  constructor(message: string) { super('provenance-refused', message); }
}

/**
 * A container that replaces the project's previous one (new pin, fnkc-ctl update) started but did not pass readiness;
 * the message ends with the tail of its readiness log. The client may offer Discard and retry: the start again with
 * StartRequest.discardReplacement (hosts with discard-replacement-v1).
 */
export class ReplacementNotReady extends CodedError {
  constructor(message: string) { super('replacement-not-ready', message); }
}

const CLASSES: Partial<Record<ErrorCode, new (message: string) => CodedError>> = {
  quota: QuotaExceeded, capacity: HostCapacity, busy: LockBusy, incompatible: Incompatible,
  'unknown-command': UnknownCommand, 'image-rejected': ImageRejected, 'provenance-refused': ProvenanceRefused,
  'replacement-not-ready': ReplacementNotReady,
};

/**
 * Hosts from before error codes send only the message: their wording is read, once and only here. New wording needs
 * no entry: it comes with a code.
 */
function legacyCode(message: string): ErrorCode | undefined {
  if (/unknown agent command/.test(message)) return 'unknown-command';
  if (/project quota reached|memory budget exceeded/.test(message)) return 'quota';
  if (/admits no project starts|host capacity/.test(message)) return 'capacity';
  if (/operation is busy|timed out waiting for/.test(message)) return 'busy';
  if (/incompatible protocol/.test(message)) return 'incompatible';
  if (/image upload: .*(does not match|wrong size)/.test(message)) return 'image-rejected';
  if (/provenance verification failed|manifest sent for .* does not match its digest/.test(message)) return 'provenance-refused';
  return undefined;
}

/** The error a host's failed reply stands for: its class by `code` (or, from an older host, by its wording). */
export function hostError(message: string, code?: string, raw = message): Error {
  const known = code && code in CLASSES ? (code as ErrorCode) : code ? undefined : legacyCode(raw);
  const Class = known && CLASSES[known];
  return Class ? new Class(message) : new Error(message);
}
