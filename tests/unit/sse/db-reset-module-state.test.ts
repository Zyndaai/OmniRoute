// TDD — 6A.1 triagem do órfão compression-preview-auth.test.ts (503 em vez de 403).
// Causa-raiz: resetar a conexão do banco NÃO disparava os resetters do registry
// stateReset.ts. Módulos com estado amarrado à conexão (ex.: apiKeys.ts memo de schema +
// prepared statements) ficavam apontando para um estado antigo: após um segundo reset com
// o banco recriado do zero, o módulo ainda reutilizava o memo e a consulta falhava com
// 503 em vez de 403.
// No PostgreSQL o banco de cada processo de teste é isolado (tests/_setup/isolatePostgres.ts);
// resetTestDb() esvazia as tabelas e recarrega o seed das migrations, e este teste garante
// que a validação de API key continua correta depois de resets repetidos.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resetTestDb } from "../../helpers/postgres.ts";

const settingsDb = await import("../../../src/lib/db/settings.ts");
const { isValidApiKey } = await import("../../../src/sse/services/auth.ts");

async function recreateDataFromScratch(): Promise<void> {
  await resetTestDb();
  // Primeiro acesso após o reset (seed das migrations preservado).
  await settingsDb.updateSettings({ requireLogin: true, setupComplete: true });
}

test("api-key validation survives a second reset with recreated data (module state resetters fire)", async () => {
  await recreateDataFromScratch();
  assert.equal(await isValidApiKey("not-a-real-key"), false);

  // Segundo ciclo: sem o wiring de reset → resetAllDbModuleState, o memo de estado
  // do módulo de API keys sobrevive ao reset e a consulta falha.
  await recreateDataFromScratch();
  assert.equal(await isValidApiKey("not-a-real-key"), false);
});
