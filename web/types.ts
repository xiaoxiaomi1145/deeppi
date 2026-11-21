export type Provider = 'deepseek' | 'openai-compatible' | 'anthropic' | 'google' | 'mistral' | 'azure' | 'demo';
export type Thinking = 'off' | 'low' | 'medium' | 'high' | 'max';
export type SessionStatus = 'idle' | 'running' | 'compacting' | 'stopping';

export interface Settings {
  provider: Provider;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  thinkingLevel: Thinking;
  temperature: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  maxTurns: number;
  autoCompact: boolean;
  keepRecentTokens: number;
  allowBash: boolean;
  bashTimeoutMs: number;
  maxToolOutput: number;
  maxSubagents: number;
  subagentModel: string;
}

export type ModelConnection = 'demo' | 'configured' | 'missing';

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
}

export interface Workspace {
  path: string;
  name: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  folders: Workspace[];
  truncated: boolean;
}

export type WorkspaceAction =
  | { action: 'save'; path: string; name?: string; activate?: boolean }
  | { action: 'select' | 'remove'; path: string };

export interface Info {
  workspace: string;
  demo: boolean;
  bashAvailable: boolean;
  defaults: Settings;
  workspaces: Workspace[];
  models: Partial<Record<Exclude<Provider, 'demo'>, ModelInfo[]>>;
  hasDefaultKey: boolean;
  rememberedKey: boolean;
  connection: ModelConnection;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  status: SessionStatus;
  cwd: string;
}

export interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  thinking?: string;
  name?: string;
  args?: Record<string, unknown>;
  state?: 'running' | 'done' | 'error';
  timestamp: number;
}

export interface Delta {
  messageId: string;
  text?: string;
  thinking?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: { name: string; description?: string; required?: boolean }[];
  script: string;
}

export interface ChildView {
  id: string;
  name: string;
  task: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  result?: string;
  updatedAt: number;
}

export interface Usage {
  input: number;
  hit: number;
  miss: number;
  unreported: number;
  output: number;
}

export interface Cache extends Usage {
  requests: number;
  last?: Usage;
  compactionInput: number;
}

export interface Compaction {
  id: string;
  at: number;
  beforeTokens: number;
  afterTokens: number;
  summarizedMessages: number;
  summary: string;
}

export interface Session extends SessionSummary {
  createdAt: number;
  settings: Settings;
  messages: MessageView[];
  tools: ToolInfo[];
  agents: ChildView[];
  cache: Cache;
  compactions: Compaction[];
  context: { estimatedTokens: number; coveredMessages: number };
  hasApiKey: boolean;
  hasSessionKey: boolean;
  connection: ModelConnection;
  canContinue: boolean;
  error?: string;
}

export type SessionUpdate = Session & { messagesFrom: number };

export interface SessionPatch {
  title?: string;
  settings?: Partial<Settings>;
  apiKey?: string | null;
}

export type DefaultsPatch = Omit<SessionPatch, 'title'> & { rememberKey?: boolean };
export type ProbeInput = Omit<SessionPatch, 'title'> & { sessionId?: string };
