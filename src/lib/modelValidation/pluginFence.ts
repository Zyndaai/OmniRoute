import { listPlugins } from "../db/plugins";
import { getActiveEvents } from "../plugins/hooks";
import { ModelValidationError } from "./http";

/**
 * A violation remains latched even if an outer chat/plugin catch handles the thrown error.
 *
 * `assertIdle` is synchronous because the dispatch fence and the plugin execution guard call
 * it on the request path; the stored-plugin count it checks is read from the database by
 * `refresh()`, which the validation service awaits before every `assertIdle` it makes itself.
 */
export async function createValidationPluginFence() {
  let violated = false;
  let activeStoredPlugins = (await listPlugins("active")).length;
  const reject = (): never => {
    violated = true;
    throw new ModelValidationError(
      422,
      "VALIDATION_PLUGINS_UNSUPPORTED",
      "Strict model validation is unavailable while runtime plugins are active"
    );
  };
  return {
    reject,
    async refresh() {
      activeStoredPlugins = (await listPlugins("active")).length;
    },
    assertIdle() {
      if (violated || activeStoredPlugins > 0 || getActiveEvents().length) reject();
    },
  };
}
