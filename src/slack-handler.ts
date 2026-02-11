import { App } from '@slack/bolt';
import { ClaudeHandler, PermissionHandler } from './claude-handler.js';
import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './logger.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { FileHandler, ProcessedFile } from './file-handler.js';
import { TodoManager, Todo } from './todo-manager.js';
import { McpManager } from './mcp-manager.js';
import { config, isToolAllowed } from './config.js';

// Permission approval response type
type PermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: InstanceType<typeof App>;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;
  private userNameCache: Map<string, string> = new Map(); // userId -> displayName
  // Pending permission approvals - approvalId -> { resolve, messageTs, channel, threadTs, input, sessionKey }
  private pendingApprovals: Map<string, {
    resolve: (response: PermissionResponse) => void;
    messageTs: string;
    channel: string;
    threadTs: string;
    input: Record<string, unknown>;
    sessionKey: string;
  }> = new Map();
  // Tool output tracking - accumulate all tool uses in a single updatable message
  private toolMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private accumulatedToolOutput: Map<string, string[]> = new Map(); // sessionKey -> array of tool outputs
  private pendingToolDisplay: Map<string, string> = new Map(); // sessionKey -> pending tool display message

  constructor(app: InstanceType<typeof App>, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.fileHandler.setSlackClient(app.client);
    this.todoManager = new TodoManager();
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // If message starts with @mention to another user (not this bot), ignore it
    if (text && text.trim().startsWith('<@')) {
      const mentionMatch = text.match(/^<@([^>]+)>/);
      if (mentionMatch) {
        const mentionedUserId = mentionMatch[1];
        const botUserId = await this.getBotUserId();

        // If the mention is NOT to this bot, ignore the message
        if (mentionedUserId !== botUserId) {
          this.logger.debug('Ignoring message that mentions another user', { mentionedUserId, botUserId });
          return;
        }
      }
    }

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }
      
      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Get user display name for context
      const userName = await this.getUserDisplayName(user);

      // Prepare the prompt with file attachments and user context
      const messageContent = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      // Include user name so Claude knows who is speaking
      const finalPrompt = `[${userName}]: ${messageContent}`;

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, '🤔');

      // Create permission handler for Slack-based approval
      const permissionHandler = this.createPermissionHandler(channel, thread_ts || ts, user, sessionKey);

      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, permissionHandler)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // Accumulate tool output
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) {
              await this.accumulateAndDisplayToolOutput(sessionKey, toolContent, channel, thread_ts || ts, say);
            }
          } else {
            // Handle regular text content - this gets its own message
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, '❌');

        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });

        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, '⏹️');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking and tool messages if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
          this.toolMessages.delete(sessionKey);
          this.accumulatedToolOutput.delete(sessionKey);
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string,
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });

    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async accumulateAndDisplayToolOutput(
    sessionKey: string,
    toolContent: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    // Get or initialize accumulated tool output array
    let accumulated = this.accumulatedToolOutput.get(sessionKey) || [];
    accumulated.push(toolContent);
    this.accumulatedToolOutput.set(sessionKey, accumulated);

    // Format all tool output as a single code block
    const formattedOutput = '```\n' + accumulated.join('\n\n---\n\n') + '\n```';

    // Check if we already have a tool message for this session
    const existingToolMessageTs = this.toolMessages.get(sessionKey);

    if (existingToolMessageTs) {
      // Update existing tool message
      try {
        await this.app.client.chat.update({
          channel,
          ts: existingToolMessageTs,
          text: formattedOutput,
        });
        this.logger.debug('Updated existing tool message', { sessionKey, messageTs: existingToolMessageTs });
      } catch (error) {
        this.logger.warn('Failed to update tool message, creating new one', error);
        // If update fails, create a new message
        await this.createNewToolMessage(formattedOutput, channel, threadTs, sessionKey, say);
      }
    } else {
      // Create new tool message
      await this.createNewToolMessage(formattedOutput, channel, threadTs, sessionKey, say);
    }
  }

  private async createNewToolMessage(
    toolOutput: string,
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: any
  ): Promise<void> {
    const result = await say({
      text: toolOutput,
      thread_ts: threadTs,
    });

    if (result?.ts) {
      this.toolMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new tool message', { sessionKey, messageTs: result.ts });
    }
  }

  // Create a permission handler for Slack-based tool approval
  private createPermissionHandler(channel: string, threadTs: string, user: string, sessionKey: string): PermissionHandler {
    return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResponse> => {
      // Check allowlist first - auto-approve if tool matches
      if (isToolAllowed(toolName, input)) {
        this.logger.debug('Tool auto-approved by allowlist', { toolName, input });
        return { behavior: 'allow', updatedInput: input };
      }

      // Not in allowlist - request user approval via Slack
      // Generate unique approval ID (input stored in Map, not in button value)
      const approvalId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Helper to clear buffered tool display on denial
      const clearPendingToolDisplay = () => {
        this.pendingToolDisplay.delete(sessionKey);
      };

      // Create approval message with buttons
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔐 *Permission Request*\n\nClaude wants to use the tool: \`${toolName}\`\n\n*Parameters:*\n\`\`\`json\n${JSON.stringify(input, null, 2).substring(0, 2000)}\n\`\`\``
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Approve"
              },
              style: "primary",
              action_id: "approve_tool",
              value: approvalId
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❌ Deny"
              },
              style: "danger",
              action_id: "deny_tool",
              value: approvalId
            }
          ]
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Requested by: <@${user}> | Tool: ${toolName}`
            }
          ]
        }
      ];

      try {
        // Send approval request to Slack
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          blocks,
          text: `Permission request for ${toolName}` // Fallback text
        });

        if (!result.ts) {
          this.logger.error('Failed to post permission message - no ts returned');
          clearPendingToolDisplay();
          return { behavior: 'deny', message: 'Failed to request permission' };
        }

        // Create promise that will be resolved when button is clicked
        return new Promise<PermissionResponse>((resolve) => {
          this.pendingApprovals.set(approvalId, {
            resolve,
            messageTs: result.ts!,
            channel,
            threadTs,
            input,
            sessionKey
          });

          // Set timeout (60 seconds - SDK limit)
          setTimeout(() => {
            if (this.pendingApprovals.has(approvalId)) {
              this.pendingApprovals.delete(approvalId);
              this.logger.info('Permission request timed out', { approvalId, toolName });

              // Update the message to show timeout
              this.app.client.chat.update({
                channel,
                ts: result.ts!,
                text: '⏱️ Permission request timed out - waiting for your guidance',
                blocks: []
              }).catch(() => {});

              // Post a message explaining that the bot is waiting for user input
              this.app.client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: '⏸️ Tool permission timed out. Please provide guidance on how to proceed.',
              }).catch((e: unknown) => {
                this.logger.warn('Failed to post timeout message', e);
              });

              clearPendingToolDisplay();
              resolve({ behavior: 'deny', message: 'Permission request timed out' });
            }
          }, 55000); // 55 seconds to leave buffer before SDK's 60s timeout
        });
      } catch (error) {
        this.logger.error('Error posting permission request', error);
        clearPendingToolDisplay();
        return { behavior: 'deny', message: 'Error requesting permission' };
      }
    };
  }

  // Map Unicode emoji to Slack emoji names
  private emojiToSlackName(emoji: string): string {
    const emojiMap: Record<string, string> = {
      '🤔': 'thinking_face',
      '⚙️': 'gear',
      '✅': 'white_check_mark',
      '❌': 'x',
      '⏹️': 'stop_button',
      '📋': 'clipboard',
      '🔄': 'arrows_counterclockwise',
    };
    return emojiMap[emoji] || emoji;
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Convert Unicode emoji to Slack name
    const slackEmoji = this.emojiToSlackName(emoji);

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === slackEmoji) {
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
        } catch (error) {
          // Ignore errors - reaction might not exist
        }
      }

      // Add the new reaction
      try {
        await this.app.client.reactions.add({
          channel: originalMessage.channel,
          timestamp: originalMessage.ts,
          name: slackEmoji,
        });
      } catch (addError: any) {
        // already_reacted is fine - the reaction is there which is what we want
        if (addError?.data?.error !== 'already_reacted') {
          throw addError;
        }
      }

      // Track the current reaction (store Slack name for removal later)
      this.currentReactions.set(sessionKey, slackEmoji);
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = '✅'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = '🔄'; // Tasks in progress
    } else {
      emoji = '📋'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async getUserDisplayName(userId: string): Promise<string> {
    // Check cache first
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const response = await this.app.client.users.info({ user: userId });
      const user = response.user as any;
      // Prefer display_name, fall back to real_name, then name
      const displayName = user?.profile?.display_name || user?.profile?.real_name || user?.name || userId;
      this.userNameCache.set(userId, displayName);
      return displayName;
    } catch (error) {
      this.logger.error('Failed to get user info', { userId, error });
      return userId; // Fall back to user ID
    }
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }
      
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }: { message: any; say: any }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }: { event: any; say: any }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }: { event: any; say: any }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }: { event: any; say: any }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body }: { ack: any; body: any }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });

      const pending = this.pendingApprovals.get(approvalId);
      if (pending) {
        // Update the message to show approval
        try {
          await this.app.client.chat.update({
            channel: pending.channel,
            ts: pending.messageTs,
            text: '✅ Tool execution approved',
            blocks: []
          });
        } catch (e) {
          // Ignore update errors
        }

        // Resolve with the original input (stored in Map)
        pending.resolve({ behavior: 'allow', updatedInput: pending.input });
        this.pendingApprovals.delete(approvalId);
      } else {
        this.logger.warn('No pending approval found for', { approvalId });
      }
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body }: { ack: any; body: any }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });

      const pending = this.pendingApprovals.get(approvalId);
      if (pending) {
        // Update the message to show denial
        try {
          await this.app.client.chat.update({
            channel: pending.channel,
            ts: pending.messageTs,
            text: '❌ Tool execution denied - waiting for your guidance',
            blocks: []
          });
        } catch (e) {
          // Ignore update errors
        }

        pending.resolve({ behavior: 'deny', message: 'User denied this action' });
        this.pendingApprovals.delete(approvalId);

        // Post a message explaining that the bot is waiting for user input
        // The SDK will send the denial to Claude, and the conversation remains active
        try {
          await this.app.client.chat.postMessage({
            channel: pending.channel,
            thread_ts: pending.threadTs,
            text: '⏸️ Tool cancelled. Please provide guidance on how to proceed.',
          });
        } catch (e) {
          this.logger.warn('Failed to post cancellation message', e);
        }
      } else {
        this.logger.warn('No pending approval found for', { approvalId });
      }
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  async sendStartupNotifications() {
    try {
      const configs = this.workingDirManager.listConfigurations();
      const channelConfigs = configs.filter(config => !config.threadTs && !config.userId);

      if (channelConfigs.length === 0) {
        this.logger.info('No channels with configured working directories');
        return;
      }

      this.logger.info('Sending startup notifications', { count: channelConfigs.length });

      for (const config of channelConfigs) {
        try {
          const channelInfo = await this.app.client.conversations.info({
            channel: config.channelId,
          });

          const channelName = (channelInfo.channel as any)?.name || config.channelId;

          await this.app.client.chat.postMessage({
            channel: config.channelId,
            text: `👋 I'm back online! Working directory for #${channelName}: \`${config.directory}\``,
          });

          this.logger.info('Sent startup notification', {
            channel: channelName,
            directory: config.directory,
          });
        } catch (error) {
          this.logger.error('Failed to send startup notification to channel', {
            channelId: config.channelId,
            error,
          });
        }
      }
    } catch (error) {
      this.logger.error('Failed to send startup notifications', error);
    }
  }
}