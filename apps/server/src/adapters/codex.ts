/**
 * Relay server — Codex agent adapter
 * ----------------------------------
 * Runs Codex CLI headless via the process runner. Codex takes its prompt as a
 * positional argument and the working directory via `-C`, so the composed prompt
 * (or resumed handoff packet) goes in the argv. `sendInput` still forwards to
 * stdin for parity with the adapter contract.
 *
 *   codex exec --skip-git-repo-check --json [-m <model>] -C <cwd> <prompt>
 *
 * A peer of Claude behind the same `AgentAdapter` interface.
 */

import { ProcessAgentAdapter, type AgentLaunchPlan } from "./process-agent";
import type { AgentCapabilities, AgentStartOptions } from "./types";

const DEFAULT_MODELS = ["gpt-5-codex"];

/** Only pass `-m` when the id is actually a Codex/OpenAI model. */
function codexModelArg(model: string | undefined): string[] {
  return model && /^(gpt|o\d|codex)/i.test(model) ? ["-m", model] : [];
}

export class CodexAdapter extends ProcessAgentAdapter {
  readonly agent = "codex" as const;
  protected readonly defaultExecutable = "codex";

  capabilities(): AgentCapabilities {
    return {
      id: "codex",
      displayName: "Codex CLI",
      supportsInput: true,
      supportsResume: true,
      models: this.config.models ?? DEFAULT_MODELS,
    };
  }

  protected plan(opts: AgentStartOptions): AgentLaunchPlan {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--json",
      ...codexModelArg(opts.model),
      "-C",
      opts.cwd,
      this.composePrompt(opts), // Codex takes the prompt as a positional arg
    ];
    return { command: this.executable, args };
  }
}

/** A ready-to-use instance with provider defaults. */
export const codexAdapter = new CodexAdapter();
