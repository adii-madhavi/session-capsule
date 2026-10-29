// Data model for capsule format 1.x. The JSON Schemas in schemas/v1 are the
// normative definition; these types mirror them for the engine.

export const FORMAT_NAME = 'session-capsule';
export const FORMAT_VERSION = '1.0';
export const SUPPORTED_FORMAT_MAJOR = 1;
export const ENGINE_VERSION = '0.1.0';

export type ToolId = 'claude-code' | 'codex' | 'manual';
export type Surface = 'desktop' | 'cli' | 'ide' | 'unknown';
export type CaptureMode = 'full' | 'context-only';
export type Completeness = 'as-recorded' | 'possibly-partial' | 'user-supplied' | 'unavailable';
export type Platform = 'win32' | 'darwin' | 'linux';

export interface GitInfo {
  head: string | null;
  branch: string | null;
  remote: string | null;
  dirty: boolean;
}

export interface IntegrityEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  format: 'session-capsule';
  formatVersion: string;
  capsuleId: string;
  createdAt: string;
  createdBy: string;
  mode: CaptureMode;
  tool: { id: ToolId; surface: Surface; version: string | null };
  source: { platform: string; arch: string };
  project: { name: string; git: GitInfo | null; fingerprint: string; fileCount: number; totalBytes: number };
  conversation: {
    completeness: Completeness;
    sessionId: string | null;
    title: string | null;
    messageCount: number;
    redactions: number;
  };
  restoration: { native: 'unsupported'; note: string };
  integrity: IntegrityEntry[];
}

export type FileStatus = 'unchanged' | 'modified' | 'added' | 'untracked' | 'unknown';

export interface FileEntry {
  path: string;
  sha256: string;
  // Hash after CRLF -> LF normalization; null for binary files. Lets import treat
  // line-ending-only differences (git autocrlf on Windows) as identical.
  normSha256: string | null;
  size: number;
  executable: boolean;
  status: FileStatus;
  baseSha256: string | null;
  baseNormSha256: string | null;
  inPayload: boolean;
}

export interface Deletion {
  path: string;
  baseSha256: string;
  baseNormSha256: string | null;
}

export interface PlatformIssue {
  path: string;
  platform: Platform;
  kind:
    | 'invalid-name'
    | 'reserved-name'
    | 'case-collision'
    | 'too-long'
    | 'existing-case-mismatch'
    | 'symlink-parent'
    | 'not-a-file';
  blocking: boolean;
  detail: string;
}

export interface FilesIndex {
  entries: FileEntry[];
  deletions: Deletion[];
  excluded: Array<{ path: string; rule: string }>;
  skipped: Array<{ path: string; reason: string }>;
  platformIssues: PlatformIssue[];
}

export type ActionType = 'command' | 'file-edit' | 'external' | 'other';

export interface ConversationMessage {
  index: number;
  role: 'user' | 'assistant' | 'tool' | 'note';
  kind: 'text' | 'tool-call' | 'tool-result';
  timestamp: string | null;
  text: string;
  toolName: string | null;
  action: { type: ActionType; summary: string } | null;
  truncated: boolean;
  source: string;
}

export interface ConversationDoc {
  origin: {
    tool: ToolId;
    surface: Surface;
    sessionId: string | null;
    title: string | null;
    toolVersion: string | null;
    extractedFrom: string;
  };
  completeness: Completeness;
  notes: string[];
  messages: ConversationMessage[];
}

// Portable handoff object shared with Blocker (desktop-continuity); normative
// definition in schemas/v1/handoff.schema.json, contract in docs/blocker-integration.md.
export const HANDOFF_KIND = 'session-capsule.handoff';
export const HANDOFF_VERSION = '1.0';

export type HandoffSurface =
  | 'codex-desktop'
  | 'codex-cli'
  | 'claude-desktop-chat'
  | 'claude-desktop-cowork'
  | 'claude-code-desktop'
  | 'claude-code-cli'
  | 'claude-code-ide'
  | 'unknown';

export interface HandoffObject {
  kind: 'session-capsule.handoff';
  version: string;
  handoffId: string;
  createdBy: { name: string; version: string };
  capturedAt: string;
  source: { tool: ToolId; surface: HandoffSurface; platform: string; toolVersion: string | null; model: string | null };
  session: {
    originalId: string | null;
    originalRef: number | null;
    sourceProjectPath: string | null;
    firstRecordedAt: string | null;
    lastRecordedAt: string | null;
  };
  events: null | {
    totalRecorded: number;
    included: number;
    omittedBefore: number;
    lastIncludedSeq: number;
    items: Array<Record<string, unknown>>;
  };
  checkpoint: null | {
    observed: Record<string, unknown>;
    agentNotes: Record<string, unknown>;
    inferred: Record<string, unknown>;
    missing: string[];
    [key: string]: unknown;
  };
  sourceStatusAtCapture: null | {
    historical: true;
    observedAt: string;
    note: string;
    exportForced: boolean;
    status: Record<string, unknown>;
  };
  coverage: { history: string; truncation: string[]; missing: string[] };
  notes: string | null;
  capsule: null | {
    id: string;
    formatVersion: string;
    mode: CaptureMode;
    createdAt: string;
    encrypted: boolean;
    fingerprint: string;
    files: Array<{ path: string; sha256: string; size: number; status: FileStatus }>;
    deletions: string[];
  };
}

export interface EnvironmentInfo {
  source: { platform: string; arch: string };
  tools: Array<{ name: string; version: string | null; note: string | null }>;
  detected: Array<{ file: string; kind: string; detail: string }>;
  steps: Array<{ title: string; command: string | null; note: string | null }>;
  envVarNames: string[];
  excludedCredentials: string[];
  notes: string[];
}
