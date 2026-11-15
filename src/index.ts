import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMorphRunsExtension } from "./morph-runs";
import { MORPH_PROVIDER, MORPH_PROVIDER_CONFIG } from "./provider";

const morphRuns = createMorphRunsExtension();

/** Registers Morph as a provider and keeps its sessions on their cached prefix. */
export default function ompMorphllm(pi: ExtensionAPI): void {
  pi.registerProvider(MORPH_PROVIDER, MORPH_PROVIDER_CONFIG);
  morphRuns(pi);
}
