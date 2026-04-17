/**
 * PKCE (RFC 7636) Utilities
 *
 * Provides code_challenge verification and cryptographic token generation
 * for the OAuth authorization server (broker mode).
 */

import crypto from "crypto";

/**
 * Verify a PKCE code_verifier against a stored code_challenge (S256 method).
 * Returns true if SHA256(code_verifier) base64url-encoded === code_challenge.
 *
 * Per RFC 7636 Section 4.1, code_verifier must be 43-128 characters.
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const computed = hash.toString("base64url");
  return computed === codeChallenge;
}

/**
 * Generate a cryptographically secure random token with a prefix.
 * Example: generateSecureToken("mcp_code", 32) -> "mcp_code_a1b2c3d4..."
 */
export function generateSecureToken(prefix: string, bytes: number = 32): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

/**
 * Generate a session ID for auth sessions.
 */
export function generateSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}
