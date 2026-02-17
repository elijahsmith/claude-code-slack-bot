export interface SessionInitInfo {
  model?: string;
  tools?: string[];
  skills?: string[];
  slashCommands?: string[];
  plugins?: Array<{ name: string; path: string }>;
  mcpServers?: Array<{ name: string; status: string }>;
  permissionMode?: string;
  claudeCodeVersion?: string;
  timestamp: Date;
}

export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
  lastInitInfo?: SessionInitInfo;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}