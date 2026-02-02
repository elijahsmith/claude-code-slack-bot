import { query, type SDKMessage, type HookCallback, type PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import { config } from './config';

// Permission handler type - returns allow/deny decision
export type PermissionHandler = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>;

// Hook to auto-approve file operations within the working directory
const createCwdAutoApproveHook = (logger: Logger): HookCallback => async (input, toolUseID, { signal }) => {
  if (input.hook_event_name !== 'PreToolUse') return {};

  const preInput = input as PreToolUseHookInput;
  const toolName = preInput.tool_name;
  const cwd = preInput.cwd;

  // Only handle file-related tools
  const fileTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
  if (!fileTools.includes(toolName)) return {};

  // Get the file path from tool input
  const toolInput = preInput.tool_input as Record<string, unknown>;
  const filePath = (toolInput?.file_path as string) || (toolInput?.path as string);  // Glob uses 'path'

  if (!filePath) {
    // No file path specified (e.g., Grep without path uses cwd) - allow
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: no specific path, defaults to cwd'
      }
    };
  }

  // Resolve to absolute path and check if within cwd
  const absolutePath = path.resolve(cwd, filePath);
  const normalizedCwd = path.resolve(cwd);

  if (absolutePath.startsWith(normalizedCwd + path.sep) || absolutePath === normalizedCwd) {
    logger.debug('Auto-approving file operation within cwd', {
      tool: toolName,
      filePath,
      absolutePath,
      cwd: normalizedCwd
    });
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: path is within working directory'
      }
    };
  }

  // Outside cwd - strictly deny
  logger.warn('Blocked file operation outside cwd', {
    tool: toolName,
    filePath,
    absolutePath,
    cwd: normalizedCwd
  });
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      permissionDecision: 'deny',
      permissionDecisionReason: `Access denied: path "${filePath}" is outside the working directory`
    }
  };
};

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    permissionHandler?: PermissionHandler
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: permissionHandler ? 'default' : 'bypassPermissions',
      // Use Claude Code's system prompt preset to maintain the same behavior
      systemPrompt: { type: 'preset', preset: 'claude_code', append: config.systemPrompt },
      settingSources: ["project"]
    };

    // Add custom system prompt if configured
    if (config.systemPrompt) {
      this.logger.info('Using custom system prompt', {
        length: config.systemPrompt.length,
        preview: config.systemPrompt.substring(0, 100) + '...'
      });
    } else {
      this.logger.debug('No custom system prompt configured');
    }

    // Add canUseTool callback for permission handling via Slack
    if (permissionHandler) {
      options.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        this.logger.debug('Permission requested for tool', { toolName, input });
        return await permissionHandler(toolName, input);
      };
      this.logger.debug('Added canUseTool callback for Slack permission handling');
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;

      // Add hook to auto-approve file operations within the working directory
      // and deny operations outside the working directory
      options.hooks = {
        PreToolUse: [
          { matcher: 'Read|Edit|Write|Glob|Grep', hooks: [createCwdAutoApproveHook(this.logger)] }
        ]
      };
      this.logger.debug('Added cwd auto-approve hook for file operations', { cwd: workingDirectory });
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();

    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }
      
      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
        hasPermissionHandler: !!permissionHandler,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    // Add abort controller to options
    if (abortController) {
      options.abortController = abortController;
    }

    try {
      for await (const message of query({
        prompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}
