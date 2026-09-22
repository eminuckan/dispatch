import { EnvironmentId, TrimmedNonEmptyString } from "@dispatch/contracts";
import * as Schema from "effect/Schema";

export class RemoteDpopAccessToken extends Schema.Class<RemoteDpopAccessToken>(
  "@dispatch/client-runtime/authorization/RemoteDpopAccessToken",
)({
  environmentId: EnvironmentId,
  accountId: Schema.optionalKey(Schema.String),
  label: Schema.String,
  // Preserve old saved catalogs without using these credentials for authorization.
  endpoint: Schema.Struct({
    httpBaseUrl: TrimmedNonEmptyString,
    wsBaseUrl: TrimmedNonEmptyString,
    providerKind: Schema.Literals(["manual", "cloudflare_tunnel", "t3_relay"]),
  }),
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  dpopThumbprint: Schema.String,
}) {}
