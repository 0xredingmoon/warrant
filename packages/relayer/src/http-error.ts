/** An error the relayer answers with a status and a plain-language message instead of a stack trace. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
