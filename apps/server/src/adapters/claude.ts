/**
 * Relay server — Claude agent adapter
 * -----------------------------------
 * Runs Claude Code headless via the process runner. Claude reads its prompt from
 * stdin, so the composed prompt (or resumed handoff packet) is written to stdin
 * after start, and `sendInput` forwards further input to the same stream.
 *
 *   claude -p --output-format json [--model <model>]
 *
 * Claude is just one `AgentAdapter` — nothing here is treated as a home base.
 */

import { ProcessAgentAdapter, type AgentLaunchPlan } from "./process-agent";
import type { AgentCapabilities, AgentStartOptions } from "./types";

const DEFAULT_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6"];

export class ClaudeAdapter extends ProcessAgentAdapter {
  readonly agent = "claude" as const;
  protected readonly defaultExecutable = "claude";

  capabilities(): AgentCapabilities {
    return {
      id: "claude",
      displayName: "Claude Code",
      supportsInput: true,
      supportsResume: true,
      models: this.config.models ?? DEFAULT_MODELS,
    };
  }

  protected plan(opts: AgentStartOptions): AgentLaunchPlan {
    const args = ["-p", "--output-format", "json"];
    if (opts.model) args.push("--model", opts.model);
    return {
      command: this.executable,
      args,
      // Claude consumes its prompt on stdin.
      stdinPrompt: this.composePrompt(opts),
    };
  }
}

/** A ready-to-use instance with provider defaults. */
export const claudeAdapter = new ClaudeAdapter();
