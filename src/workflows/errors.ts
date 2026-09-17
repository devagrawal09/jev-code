/** Invalid or unacceptable user-supplied input. Port implementations throw it for malformed input too. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
