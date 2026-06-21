/**
 * Relay session contracts shared by the server, UI, persistence, and runtime.
 * Lifecycle behavior belongs to the server's SessionManager; the wire shapes
 * live here so every layer validates the same data.
 */

import { z } from "zod";
import { AgentId } from "./common";

export const SESSION_STATES = [
  "created",
  "claude_running",
  "handoff_building",
  "handoff_ready",
  "codex_running",
  "verifying",
  "completed",
  "failed",
] as const;

export const SessionState = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof SessionState>;

export const RelaySession = z.object({
  id: z.string(),
  state: SessionState,
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  verificationCommand: z.string(),
  workspaceDir: z.string(),
  sourceAgent: AgentId,
  targetAgent: AgentId.nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RelaySession = z.infer<typeof RelaySession>;

/** Public request body for creating a session. Filesystem checks stay server-side. */
export const CreateSessionRequest = z.object({
  goal: z.string().trim().min(1, "goal is required"),
  verificationCommand: z
    .string()
    .trim()
    .min(1, "verificationCommand is required"),
  workspaceDir: z.string().trim().min(1, "workspaceDir is required"),
  acceptanceCriteria: z.array(z.string()).optional(),
  sourceAgent: AgentId.optional(),
  targetAgent: AgentId.nullable().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
