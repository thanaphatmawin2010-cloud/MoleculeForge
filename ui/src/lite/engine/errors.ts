/** JSON-RPC error codes, identical to the desktop sidecar's (compute/mfcompute/rpc.py). */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const JOB_CANCELLED = -32000;
export const ENGINE_UNAVAILABLE = -32001;
export const CHEMISTRY_ERROR = -32002;
export const TIMEOUT = -32003;
export const TOO_LARGE = -32004;
export const NOT_FOUND = -32005;
export const CONFLICT = -32006;

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RpcFailure";
  }
}
