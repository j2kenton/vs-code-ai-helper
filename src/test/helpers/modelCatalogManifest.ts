/**
 * Shared access to the model-catalog audit manifest for tests. The path is
 * resolved from the compiled location (`out/test/helpers`) up to the
 * repository root, so it never contains an `out` segment.
 */
import { resolveAuditManifestPath } from "../../utils/modelCatalogAudit";

export { loadAuditManifest } from "../../utils/modelCatalogAudit";

export const AUDIT_MANIFEST_PATH = resolveAuditManifestPath(__dirname);
