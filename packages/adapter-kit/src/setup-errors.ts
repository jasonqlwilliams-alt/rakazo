/** A provisioning/configuration refusal that retrying the same run cannot repair. */
export class PermanentSetupError extends Error {
  readonly code = "PERMANENT_SETUP_FAILURE";

  constructor(message: string) {
    super(message);
    this.name = "PermanentSetupError";
  }
}
