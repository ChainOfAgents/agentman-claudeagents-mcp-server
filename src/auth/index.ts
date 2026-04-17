/**
 * Auth Module Exports
 */

export { default as oauthMetadataRouter } from "./oauth-metadata.js";
export {
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
} from "./oauth-metadata.js";
export type {
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
} from "./oauth-metadata.js";

export {
  extractBearerToken,
  getRequestContext,
  requireAuth,
  optionalAuth,
} from "./token.js";
export type { TokenResult, RequestContext } from "./token.js";

// OAuth Authorization Server (Broker)
export { oauthServerRouter } from "./oauth-server.js";

// PKCE utilities
export { verifyPkce, generateSecureToken, generateSessionId } from "./pkce.js";
