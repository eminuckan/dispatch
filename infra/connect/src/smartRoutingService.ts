import type { SmartRoutingConfig } from "./config.ts";
import {
  callSmartRoutingProvider,
  decodeSmartRoutingResponse,
  parseSmartRoutingInput,
  SmartRoutingError,
  smartRoutingDigest,
  smartRoutingFallback,
  smartRoutingInputTokens,
  smartRoutingRequest,
  type SmartRoutingOperation,
  type SmartRoutingResult,
} from "./smartRouting.ts";
import type { SmartRoutingPrincipal, SmartRoutingStore } from "./smartRoutingStore.ts";

export class SmartRoutingService {
  private readonly store: Pick<SmartRoutingStore, "reserve" | "complete" | "capability">;
  private readonly config: SmartRoutingConfig;
  private readonly digestSecret: string;
  private readonly fetcher: typeof fetch;

  constructor(input: {
    readonly store: Pick<SmartRoutingStore, "reserve" | "complete" | "capability">;
    readonly config: SmartRoutingConfig;
    readonly digestSecret: string;
    readonly fetch?: typeof fetch;
  }) {
    this.store = input.store;
    this.config = input.config;
    this.digestSecret = input.digestSecret;
    this.fetcher = input.fetch ?? fetch;
  }

  capability(principal: SmartRoutingPrincipal) {
    return this.store.capability(principal, this.config);
  }

  async execute(
    principal: SmartRoutingPrincipal,
    operation: SmartRoutingOperation,
    body: unknown,
    ipHash: string,
  ): Promise<SmartRoutingResult> {
    const input = parseSmartRoutingInput(operation, body);
    if (input.candidates.length === 0) return smartRoutingFallback(operation, input);
    const request = smartRoutingRequest(operation, input);
    const digest = smartRoutingDigest(
      this.digestSecret,
      operation,
      JSON.stringify({
        request,
        candidateIds: input.candidates.map((candidate) => candidate.id),
      }),
    );
    const reservation = await this.store.reserve({
      principal,
      operation,
      requestId: input.requestId,
      digest,
      ipHash,
      config: this.config,
    });
    if (reservation.kind === "cached") return reservation.response;
    let result: SmartRoutingResult;
    let inputTokens: number | null;
    try {
      const response = await callSmartRoutingProvider(this.config.apiKey, request, this.fetcher);
      result = decodeSmartRoutingResponse(operation, input, response);
      inputTokens = smartRoutingInputTokens(response);
    } catch {
      // A failed or timed-out HTTP call may still be billed upstream. Never refund its allowance.
      await this.store.complete(principal, input.requestId, null);
      throw new SmartRoutingError(503, "smart_routing_upstream_unavailable");
    }
    await this.store.complete(principal, input.requestId, result, inputTokens);
    return result;
  }
}
