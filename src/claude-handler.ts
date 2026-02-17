import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ConversationSession } from './types.js';
import { Logger } from './logger.js';
import { McpManager, McpServerConfig } from './mcp-manager.js';
import { config } from './config.js';
import { storage } from './storage.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Permission handler type - returns allow/deny decision
export type PermissionHandler = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>;

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.loadFromStorage();
  }

  private loadFromStorage() {
    const stored = storage.listSessions();
    for (const row of stored) {
      const session: ConversationSession = {
        userId: row.user_id,
        channelId: row.channel_id,
        threadTs: row.thread_ts || undefined,
        // Restore sessionId - SDK will resume the conversation from disk
        sessionId: row.session_id || undefined,
        isActive: true,
        lastActivity: new Date(row.last_activity),
      };
      this.sessions.set(row.session_key, session);
    }
    this.logger.info('Loaded sessions from storage', {
      count: stored.length,
      withSessionIds: stored.filter(s => s.session_id).length
    });

    // Run startup diagnostics to verify SDK session data is actually present on disk
    this.verifySessionIntegrity();
  }

  /**
   * Verify that SDK session data exists on disk for all stored session IDs.
   * Logs warnings for orphaned mappings and clears them so they don't cause
   * resume failures at runtime.
   */
  private verifySessionIntegrity() {
    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');
    const projectsDir = path.join(claudeDir, 'projects');

    // Log the SDK data directory state
    const claudeDirExists = fs.existsSync(claudeDir);
    const projectsDirExists = fs.existsSync(projectsDir);

    this.logger.info('Session integrity check - SDK directory state', {
      homeDir,
      claudeDir,
      claudeDirExists,
      projectsDirExists,
      claudeDirContents: claudeDirExists ? this.safeReaddir(claudeDir) : [],
      projectsDirContents: projectsDirExists ? this.safeReaddir(projectsDir) : [],
    });

    // Check each session that claims to have a resumable sessionId
    let verified = 0;
    let orphaned = 0;

    for (const [key, session] of this.sessions.entries()) {
      if (!session.sessionId) continue;

      // The SDK stores session data somewhere under ~/.claude - we can't know the
      // exact path without SDK internals, but we can check if there's ANY project data
      if (!projectsDirExists) {
        this.logger.warn('Session has sessionId but no SDK projects directory exists - clearing', {
          sessionKey: key,
          sessionId: session.sessionId,
        });
        session.sessionId = undefined;
        storage.saveSession(key, session.userId, session.channelId, session.threadTs, undefined);
        orphaned++;
        continue;
      }

      // Try to find the session file in any project subdirectory
      const found = this.findSessionOnDisk(projectsDir, session.sessionId);
      if (found) {
        verified++;
        this.logger.debug('Session verified on disk', {
          sessionKey: key,
          sessionId: session.sessionId,
          path: found,
        });
      } else {
        this.logger.warn('Session ID not found on disk - clearing to prevent resume failure', {
          sessionKey: key,
          sessionId: session.sessionId,
        });
        session.sessionId = undefined;
        storage.saveSession(key, session.userId, session.channelId, session.threadTs, undefined);
        orphaned++;
      }
    }

    this.logger.info('Session integrity check complete', {
      total: this.sessions.size,
      withSessionIds: verified + orphaned,
      verified,
      orphaned,
    });
  }

  private safeReaddir(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  private findSessionOnDisk(projectsDir: string, sessionId: string): string | null {
    try {
      // Walk project subdirectories looking for the session ID in filenames
      const projects = fs.readdirSync(projectsDir);
      for (const project of projects) {
        const projectPath = path.join(projectsDir, project);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory()) continue;

        const files = this.safeReaddir(projectPath);
        for (const file of files) {
          if (file.includes(sessionId)) {
            return path.join(projectPath, file);
          }
        }
      }
    } catch (error) {
      this.logger.error('Error scanning SDK projects directory', error);
    }
    return null;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  getSessionByKey(sessionKey: string): ConversationSession | undefined {
    return this.sessions.get(sessionKey);
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    const sessionKey = this.getSessionKey(userId, channelId, threadTs);
    this.sessions.set(sessionKey, session);

    // Persist to storage
    storage.saveSession(sessionKey, userId, channelId, threadTs, undefined);

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
      settingSources: ["project", "local"]
    };

    // Add custom system prompt if configured
    if (config.systemPrompt) {
      this.logger.info('Using custom system prompt', {
        length: config.systemPrompt.length,
        preview: config.systemPrompt.substring(0, 100) + '...'
      });
    }

    // Add canUseTool callback for permission handling via Slack
    if (permissionHandler) {
      options.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        return await permissionHandler(toolName, input);
      };
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
      // Docker container is the security boundary - cwd is just context for Claude
    }

    // Add MCP server configuration if available (filtered by working directory)
    const mcpServers = this.mcpManager.getServerConfigurationForCwd(workingDirectory);

    if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools from the filtered servers
      const defaultMcpTools = this.mcpManager.getDefaultAllowedToolsForCwd(workingDirectory);
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        cwd: workingDirectory,
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
            session.lastActivity = new Date();

            const initMsg = message as any;

            // Capture init info for debug diagnostics
            session.lastInitInfo = {
              model: initMsg.model,
              tools: initMsg.tools || [],
              skills: initMsg.skills || [],
              slashCommands: initMsg.slash_commands || [],
              plugins: initMsg.plugins || [],
              mcpServers: initMsg.mcp_servers || [],
              permissionMode: initMsg.permissionMode,
              claudeCodeVersion: initMsg.claude_code_version,
              timestamp: new Date(),
            };

            // Persist updated session with sessionId
            const sessionKey = this.getSessionKey(session.userId, session.channelId, session.threadTs);
            storage.saveSession(sessionKey, session.userId, session.channelId, session.threadTs, session.sessionId);

            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: initMsg.model,
              tools: initMsg.tools?.length || 0,
              skills: initMsg.skills || [],
              slashCommands: initMsg.slash_commands || [],
              plugins: initMsg.plugins || [],
            });
          }
        }

        // Update last activity timestamp for any message
        if (session) {
          session.lastActivity = new Date();
        }

        yield message;
      }
    } catch (error) {
      // If session resume failed, clear the stale sessionId and let caller retry
      if (session?.sessionId && error instanceof Error &&
          (error.message.includes('exited with code 1') || error.message.includes('resume'))) {
        this.logger.warn('Session resume failed, clearing stale session', {
          sessionId: session.sessionId,
          error: error.message
        });
        session.sessionId = undefined;
        const sessionKey = this.getSessionKey(session.userId, session.channelId, session.threadTs);
        storage.saveSession(sessionKey, session.userId, session.channelId, session.threadTs, undefined);
      }
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 14 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        storage.deleteSession(key);
        cleaned++;
      }
    }

    // Also clean from storage (belt and suspenders)
    storage.cleanOldSessions(maxAge);

    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }

  /**
   * Build debug diagnostics for a given context (channel/thread/user).
   * Returns a formatted string suitable for posting to Slack.
   */
  getDebugInfo(channelId: string, threadTs?: string, userId?: string, workingDirectory?: string): string {
    const sessionKey = userId ? this.getSessionKey(userId, channelId, threadTs) : undefined;
    const session = sessionKey ? this.sessions.get(sessionKey) : undefined;

    const lines: string[] = [];
    lines.push('🔍 *Debug Info*\n');

    // Working directory
    lines.push(`*Working Directory:* \`${workingDirectory || '(not set)'}\``);

    // Check for .claude/skills in the working directory
    if (workingDirectory) {
      const skillsDir = path.join(workingDirectory, '.claude', 'skills');
      const skillsDirExists = fs.existsSync(skillsDir);
      lines.push(`*Skills Directory:* \`${skillsDir}\` ${skillsDirExists ? '✅ exists' : '❌ not found'}`);

      if (skillsDirExists) {
        try {
          const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
          const skillNames = skillEntries
            .filter(e => e.isDirectory())
            .map(e => e.name);
          lines.push(`*Skills on disk:* ${skillNames.length > 0 ? skillNames.map(s => `\`${s}\``).join(', ') : '(none)'}`);
        } catch {
          lines.push(`*Skills on disk:* ⚠️ could not read directory`);
        }
      }

      // Check for CLAUDE.md
      const claudeMd = path.join(workingDirectory, 'CLAUDE.md');
      const claudeMdExists = fs.existsSync(claudeMd);
      lines.push(`*CLAUDE.md:* \`${claudeMd}\` ${claudeMdExists ? '✅ exists' : '❌ not found'}`);
    }

    // Session info
    lines.push('');
    if (session) {
      lines.push(`*Session Key:* \`${sessionKey}\``);
      lines.push(`*Session ID:* \`${session.sessionId || '(none - new session)'}\``);
      lines.push(`*Last Activity:* ${session.lastActivity.toISOString()}`);

      // Last init info from SDK
      if (session.lastInitInfo) {
        const info = session.lastInitInfo;
        lines.push('');
        lines.push('*Last SDK Init:*');
        lines.push(`  Model: \`${info.model || 'unknown'}\``);
        lines.push(`  Claude Code Version: \`${info.claudeCodeVersion || 'unknown'}\``);
        lines.push(`  Permission Mode: \`${info.permissionMode || 'unknown'}\``);
        lines.push(`  Tools: ${info.tools?.length || 0}`);
        lines.push(`  Skills: ${info.skills?.length ? info.skills.map(s => `\`${s}\``).join(', ') : '(none)'}`);
        lines.push(`  Slash Commands: ${info.slashCommands?.length ? info.slashCommands.map(s => `\`${s}\``).join(', ') : '(none)'}`);
        lines.push(`  MCP Servers: ${info.mcpServers?.length ? info.mcpServers.map(s => `\`${s.name}\` (${s.status})`).join(', ') : '(none)'}`);
        lines.push(`  Plugins: ${info.plugins?.length ? info.plugins.map(p => `\`${p.name}\``).join(', ') : '(none)'}`);
        lines.push(`  Init Time: ${info.timestamp.toISOString()}`);
      } else {
        lines.push('*Last SDK Init:* (no session started yet)');
      }
    } else {
      lines.push(`*Session:* (no active session for this context)`);
    }

    // System prompt info
    lines.push('');
    lines.push(`*System Prompt:* ${config.systemPrompt ? `${config.systemPrompt.length} chars` : '(none)'}`);

    // MCP servers for this cwd
    const mcpServers = this.mcpManager.getServerConfigurationForCwd(workingDirectory);
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      lines.push(`*MCP Servers (for cwd):* ${Object.keys(mcpServers).map(s => `\`${s}\``).join(', ')}`);
    } else {
      lines.push(`*MCP Servers (for cwd):* (none)`);
    }

    // SDK session data directory
    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');
    const projectsDir = path.join(claudeDir, 'projects');
    lines.push('');
    lines.push(`*SDK Home:* \`${claudeDir}\` ${fs.existsSync(claudeDir) ? '✅' : '❌'}`);
    lines.push(`*SDK Projects:* \`${projectsDir}\` ${fs.existsSync(projectsDir) ? '✅' : '❌'}`);
    if (fs.existsSync(projectsDir)) {
      try {
        const projects = fs.readdirSync(projectsDir);
        lines.push(`*SDK Project Dirs:* ${projects.length > 0 ? projects.map(p => `\`${p}\``).join(', ') : '(empty)'}`);
      } catch {
        lines.push(`*SDK Project Dirs:* ⚠️ could not read`);
      }
    }

    // Setting sources
    lines.push('');
    lines.push(`*Setting Sources:* \`["project", "local"]\``);

    return lines.join('\n');
  }
}
