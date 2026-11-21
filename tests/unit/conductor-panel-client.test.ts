import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Componentes React são cobertos pelo vitest-ui (advisory) + dashboard-typecheck;
// este source-scan trava os invariantes de segurança/UX que revisão nenhuma pode perder.
const CLIENT = "src/app/(dashboard)/dashboard/conductor/ConductorPageClient.tsx";
const PAGE = "src/app/(dashboard)/dashboard/conductor/page.tsx";

test("client: poll com setInterval + clearInterval; fala SÓ com /api/conductor (nunca com o hub)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), CLIENT), "utf8");
  assert.doesNotMatch(src, /from "(node:[^"]+|@[/]lib[/]db[^"]*|@[/]server[^"]*|@[/]i18n[/]server|server-only)"/, "client code imports no server module");
  assert.match(src, /setInterval\(/);
  assert.match(src, /clearInterval\(/);
  assert.match(src, /\/api\/conductor\/fleet/);
  assert.ok(!src.includes("CONDUCTOR_HUB"), "nenhuma env do hub no client");
  assert.ok(!src.includes(":7910"), "nenhum endereço de hub hardcoded no client");
});

test("client: cancelar é destrutivo → ConfirmModal antes do POST", () => {
  const src = fs.readFileSync(path.join(process.cwd(), CLIENT), "utf8");
  assert.match(src, /ConfirmModal/);
  const confirmAt = src.indexOf("<ConfirmModal");
  const cancelPost = src.indexOf("/cancel");
  assert.ok(confirmAt > 0 && cancelPost > 0, "ConfirmModal e POST cancel presentes");
  assert.match(src, /useTranslations\("conductor"\)/, "strings via i18n, namespace conductor");
});

test("page: wrapper fino; título via loader + export meta (um só <title>)", () => {
  const src = fs.readFileSync(path.join(process.cwd(), PAGE), "utf8");
  assert.match(src, /export const meta/);
  assert.match(src, /export async function loader/);
  assert.doesNotMatch(src, /<title>/, "o título vem do meta, não de um <title> no componente");
  assert.match(src, /ConductorPageClient/);
  assert.doesNotMatch(src, /from "(node:[^"]+|@[/]lib[/]db[^"]*|@[/]server[^"]*|server-only)"/, "page.tsx não importa módulo de servidor");
  // @/i18n/request.server is allowed only for the loader: the component must not reference it.
  const componentPart = src.slice(src.indexOf("export default function"));
  assert.doesNotMatch(componentPart, /getTranslator/);
});
