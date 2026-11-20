// -----------------------------------------------------------------------------
// Every failure of the Incus API is an IncusError of a kind the texts explain
// to the user (src/texts.js).
// -----------------------------------------------------------------------------

export const ERROR_KINDS = Object.freeze({
  // Nothing answers (refused, timed out, DNS).
  UNREACHABLE: 'unreachable',
  // Something answers, but not the Incus or LXD API.
  NOT_INCUS: 'not_incus',
  // The server does not know the certificate of the integration yet.
  UNTRUSTED: 'untrusted',
  // The trust token was refused (expired, already used, mistyped).
  TOKEN_REFUSED: 'token_refused',
  // The server presents another certificate than the pinned one.
  CERT_CHANGED: 'cert_changed',
  // The certificate is trusted, but restricted away from this operation.
  FORBIDDEN: 'forbidden',
  // The instance named does not exist (any more).
  NOT_FOUND: 'not_found',
  // Incus refused or failed the operation (its message in `cause`).
  REFUSED: 'refused',
  // Any other answer.
  HTTP: 'http',
});

export class IncusError extends Error {
  /**
   * @param {string} kind an ERROR_KINDS value
   * @param {string} message for the logs (never shown as is to the user)
   * @param {object} [details] `status`, `cause` (the message of Incus)
   */
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'IncusError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.cause = details.cause ?? null;
  }
}
