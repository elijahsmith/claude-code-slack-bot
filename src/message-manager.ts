import slackBolt from '@slack/bolt';
import { Logger } from './logger.js';

const { App } = slackBolt;

/**
 * Manages different types of messages in Slack conversations
 * - Task List: Single persistent message, updates in place
 * - Tool Output: Simple code block that Slack auto-collapses with "see more"
 * - Status: Single message that updates in place
 * - Text: Regular messages that always create new messages
 */

export interface MessageWindow {
  ts: string;
  lastUpdated: Date;
  channel?: string;
  threadTs?: string;
}

export class MessageManager {
  private logger = new Logger('MessageManager');

  // Track message timestamps by session and type
  private taskListMessages: Map<string, MessageWindow> = new Map();
  private toolOutputMessages: Map<string, MessageWindow> = new Map();
  private statusMessages: Map<string, MessageWindow> = new Map();

  // Track accumulated tool output per session (full details)
  private accumulatedToolOutput: Map<string, string[]> = new Map();

  // Track if text message was posted after tool output (determines if we need to bump)
  private textMessageAfterTool: Map<string, boolean> = new Map();

  // Track "Show All" expansion state per session
  private toolOutputExpanded: Map<string, boolean> = new Map();

  constructor(private app: InstanceType<typeof App>) {}

  /**
   * Update or create a task list message (always updates in place)
   */
  async updateTaskList(
    sessionKey: string,
    content: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const existing = this.taskListMessages.get(sessionKey);

    if (existing) {
      // Update in place
      try {
        await this.app.client.chat.update({
          channel,
          ts: existing.ts,
          text: content,
        });
        existing.lastUpdated = new Date();
        this.logger.debug('Updated task list message in place', { sessionKey, ts: existing.ts });
      } catch (error) {
        this.logger.warn('Failed to update task list message, creating new one', error);
        // If update fails, create new message
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: content,
        });
        if (result.ts) {
          this.taskListMessages.set(sessionKey, {
            ts: result.ts,
            lastUpdated: new Date(),
          });
        }
      }
    } else {
      // Create new message
      const result = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: content,
      });

      if (result.ts) {
        this.taskListMessages.set(sessionKey, {
          ts: result.ts,
          lastUpdated: new Date(),
        });
        this.logger.debug('Created new task list message', { sessionKey, ts: result.ts });
      }
    }
  }

  /**
   * Update or create a tool output message with expandable history
   */
  async updateToolOutput(
    sessionKey: string,
    toolContent: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    // Accumulate tool output
    const accumulated = this.accumulatedToolOutput.get(sessionKey) || [];
    accumulated.push(toolContent);
    this.accumulatedToolOutput.set(sessionKey, accumulated);

    const existing = this.toolOutputMessages.get(sessionKey);
    const shouldBump = existing && this.textMessageAfterTool.get(sessionKey);

    if (shouldBump) {
      // Text came after tools - start a fresh tool output message
      this.toolOutputMessages.delete(sessionKey);
      this.accumulatedToolOutput.set(sessionKey, [toolContent]); // Reset to just this tool
      this.toolOutputExpanded.delete(sessionKey); // Reset expansion state
    }

    // Build blocks with smart expansion
    const { text, blocks } = this.buildToolOutputBlocks(sessionKey, accumulated);

    if (existing && !shouldBump) {
      // Update in place (tool is already at bottom)
      try {
        await this.app.client.chat.update({
          channel,
          ts: existing.ts,
          text,
          blocks,
        });
        existing.lastUpdated = new Date();
        this.logger.debug('Updated tool output message in place', { sessionKey, ts: existing.ts });
      } catch (error) {
        this.logger.warn('Failed to update tool output message', error);
      }
    } else {
      // Create new message (first time or after bump)
      const result = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        blocks,
      });

      if (result.ts) {
        this.toolOutputMessages.set(sessionKey, {
          ts: result.ts,
          lastUpdated: new Date(),
          channel,
          threadTs,
        });
        this.logger.debug('Created new tool output message', { sessionKey, ts: result.ts });
      }
    }

    // Mark that tool output is now the latest (reset the flag)
    this.textMessageAfterTool.set(sessionKey, false);
  }

  /**
   * Build rich blocks for tool output with expandable history
   * Shows last 2-3 calls, with older calls in expandable section
   */
  private buildToolOutputBlocks(sessionKey: string, accumulated: string[]): { text: string; blocks: any[] } {
    const recentCount = 3;
    const isExpanded = this.toolOutputExpanded.get(sessionKey) || false;

    if (accumulated.length <= recentCount) {
      // Few enough to show all
      const fullOutput = accumulated.join('\n---\n');
      return {
        text: 'Tool output',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`\n${fullOutput}\n\`\`\``,
            },
          },
        ],
      };
    }

    // Split into recent and older
    const recent = accumulated.slice(-recentCount);
    const older = accumulated.slice(0, -recentCount);

    const blocks: any[] = [];

    // Show older calls (expanded or summary)
    if (isExpanded) {
      // Show all older calls
      const olderOutput = older.join('\n---\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`\n${olderOutput}\n\`\`\``,
        },
      });
    } else {
      // Show summary
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_${older.length} earlier tool calls_`,
          },
        ],
      });
    }

    // Toggle button
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: isExpanded ? 'Hide Older Calls' : 'Show All Calls',
          },
          action_id: 'toggle_tool_history',
          value: sessionKey,
        },
      ],
    });

    blocks.push({
      type: 'divider',
    });

    // Show recent calls
    const recentOutput = recent.join('\n---\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${recentOutput}\n\`\`\``,
      },
    });

    return {
      text: 'Tool output',
      blocks,
    };
  }

  /**
   * Toggle the expansion state of tool history
   */
  toggleToolHistory(sessionKey: string): void {
    const current = this.toolOutputExpanded.get(sessionKey) || false;
    this.toolOutputExpanded.set(sessionKey, !current);
    this.logger.debug('Toggled tool history expansion', { sessionKey, newState: !current });
  }

  /**
   * Re-render tool output after toggle (called by button action handler)
   */
  async rerenderToolOutput(sessionKey: string): Promise<void> {
    const message = this.toolOutputMessages.get(sessionKey);
    const accumulated = this.accumulatedToolOutput.get(sessionKey);

    if (!message || !accumulated || !message.channel) {
      this.logger.warn('Cannot rerender tool output - missing state', { sessionKey });
      return;
    }

    const { text, blocks } = this.buildToolOutputBlocks(sessionKey, accumulated);

    try {
      await this.app.client.chat.update({
        channel: message.channel,
        ts: message.ts,
        text,
        blocks,
      });
      message.lastUpdated = new Date();
      this.logger.debug('Rerendered tool output after toggle', { sessionKey });
    } catch (error) {
      this.logger.error('Failed to rerender tool output', error);
    }
  }

  /**
   * Post a text message (always creates new message)
   */
  async postTextMessage(
    sessionKey: string,
    content: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    // Always create new message
    await this.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: content,
    });

    // Mark that text came after tool output (so next tool needs to bump)
    this.textMessageAfterTool.set(sessionKey, true);

    this.logger.debug('Posted text message', { sessionKey });
  }

  /**
   * Post a rich message with custom Slack blocks (always creates new message)
   */
  async postRichMessage(
    sessionKey: string,
    text: string,
    blocks: any[],
    channel: string,
    threadTs: string
  ): Promise<void> {
    // Always create new message with blocks
    await this.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks,
    });

    // Mark that text came after tool output (so next tool needs to bump)
    this.textMessageAfterTool.set(sessionKey, true);

    this.logger.debug('Posted rich blocks message', { sessionKey, blockCount: blocks.length });
  }

  /**
   * Update or create a status message
   * Always updates in place, never bumps
   */
  async updateStatus(
    sessionKey: string,
    content: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    const existing = this.statusMessages.get(sessionKey);

    if (existing) {
      // Update in place
      try {
        await this.app.client.chat.update({
          channel,
          ts: existing.ts,
          text: content,
        });
        existing.lastUpdated = new Date();
        this.logger.debug('Updated status message', { sessionKey, ts: existing.ts });
      } catch (error) {
        this.logger.warn('Failed to update status message', error);
      }
    } else {
      // Create new message
      const result = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: content,
      });

      if (result.ts) {
        this.statusMessages.set(sessionKey, {
          ts: result.ts,
          lastUpdated: new Date(),
        });
        this.logger.debug('Created new status message', { sessionKey, ts: result.ts });
      }
    }
  }

  /**
   * Clean up all messages for a session
   */
  cleanup(sessionKey: string): void {
    this.taskListMessages.delete(sessionKey);
    this.toolOutputMessages.delete(sessionKey);
    this.statusMessages.delete(sessionKey);
    this.accumulatedToolOutput.delete(sessionKey);
    this.textMessageAfterTool.delete(sessionKey);
    this.toolOutputExpanded.delete(sessionKey);
    this.logger.debug('Cleaned up messages for session', { sessionKey });
  }
}
