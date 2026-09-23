export interface AuthenticatedIdentity {
  userId: string;
  email: string;
  role: "HR_USER" | "HR_ADMIN" | "SYSTEM_ADMIN";
}

/**
 * Auth abstraction (architecture doc, Decision 7): V1 ships only
 * EmailPasswordStrategy, but every route depends on this interface, not on
 * password-specific logic. Adding OIDC/SAML/Google Workspace/Azure AD later
 * means adding an OidcStrategy implementing the same shape and wiring it in
 * where EmailPasswordStrategy is constructed today — the RBAC model
 * (roles, permission checks) is untouched either way.
 */
export interface AuthStrategy {
  readonly name: string;
  authenticate(credentials: Record<string, unknown>): Promise<AuthenticatedIdentity | null>;
}
