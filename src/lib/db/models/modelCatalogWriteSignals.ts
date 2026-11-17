import { invalidateModelCatalogCache } from "../readCache";

export function finishModelCatalogWriteWithoutBackup(): void {
  invalidateModelCatalogCache();
}
