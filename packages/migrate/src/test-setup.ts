import { loadCatalog } from "@ottersql/catalog";

// Loading PGlite and snapshotting an empty database happens once per worker; done here, that
// one-off cost is not charged to whichever test happens to run first.
await loadCatalog("");
