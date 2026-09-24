/**
 * Shared between the API's candidate upload route and the worker's identity
 * resolution job (Phase 7 moves Candidate creation into the worker for the
 * paths that require it — see worker/src/identity-resolution.ts) so both
 * ever call exactly one implementation. Behavior preserved verbatim from
 * its original home in apps/api/src/modules/candidates/routes.ts.
 */
export function deriveFullNameFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const spaced = withoutExtension.replace(/[_-]+/g, " ").trim();
  return spaced.length > 0 ? spaced : filename;
}
