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
}

export class MessageManager {
  private logger = new Logger('MessageManager');

  // Track message timestamps by session and type
  private taskListMessages: Map<string, MessageWindow> = new Map();
  private toolOutputMessages: Map<string, MessageWindow> = new Map();
  private statusMessages: Map<string, MessageWindow> = new Map();

  // Track accumulated tool output per session (full details)
  private accumulatedToolOutput: Map<string, string[]> = new Map();

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
   * Update or create a tool output message (simple code block, Slack auto-collapses)
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

    // Format all accumulated output as code block
    const fullOutput = accumulated.join('\n---\n');
    const formattedOutput = `\`\`\`\n${fullOutput}\n\`\`\``;

    const existing = this.toolOutputMessages.get(sessionKey);

    // Use blocks with section to get Slack's collapse behavior
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: formattedOutput,
        },
      },
    ];

    if (existing) {
      // Update in place
      try {
        await this.app.client.chat.update({
          channel,
          ts: existing.ts,
          text: formattedOutput,
          blocks,
        });
        existing.lastUpdated = new Date();
        this.logger.debug('Updated tool output message', { sessionKey, ts: existing.ts });
      } catch (error) {
        this.logger.warn('Failed to update tool output message', error);
      }
    } else {
      // Create new message
      const result = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: formattedOutput,
        blocks,
      });

      if (result.ts) {
        this.toolOutputMessages.set(sessionKey, {
          ts: result.ts,
          lastUpdated: new Date(),
        });
        this.logger.debug('Created new tool output message', { sessionKey, ts: result.ts });
      }
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

    this.logger.debug('Posted text message', { sessionKey });
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
    this.logger.debug('Cleaned up messages for session', { sessionKey });
  }
}
