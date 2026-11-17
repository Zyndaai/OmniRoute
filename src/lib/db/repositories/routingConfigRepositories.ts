import type {
  ComboRepository,
  ModelComboMappingRepository,
} from "@/domain/persistence/comboRepositories";
import { comboRepository } from "./comboRepository";
import { modelComboMappingRepository } from "./modelComboMappingRepository";

export interface RoutingConfigRepositories {
  combos: ComboRepository;
  modelComboMappings: ModelComboMappingRepository;
}

/** Composition root for the routing-config repositories (PostgreSQL). */
export const routingConfigRepositories: RoutingConfigRepositories = {
  combos: comboRepository,
  modelComboMappings: modelComboMappingRepository,
};
