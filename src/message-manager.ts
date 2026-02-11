import slackBolt from '@slack/bolt';
import { Logger } from './logger.js';

const { App } = slackBolt;

/**
 * Manages different types of messages in Slack conversations
 * - Task List: Single persistent message that bumps on significant changes
 * - Tool Output: Single persistent message that never bumps, interrupted by text
 * - Status: Single message that updates in place
 * - Text: Regular messages that always create new messages
 */

export interface MessageWindow {
  ts: string;
  lastUpdated: Date;
}

export type WindowType = 'tool' | 'text';

export class MessageManager {
  private logger = new Logger('MessageManager');

  // Track message timestamps by session and type
  private taskListMessages: Map<string, MessageWindow> = new Map();
  private toolOutputMessages: Map<string, MessageWindow> = new Map();
  private statusMessages: Map<string, MessageWindow> = new Map();

  // Track accumulated tool output per session
  private accumulatedToolOutput: Map<string, string[]> = new Map();

  // Track current window type (tool vs text)
  private currentWindow: Map<string, WindowType> = new Map();

  constructor(private app: InstanceType<typeof App>) {}

  /**
   * Update or create a task list message
   * Bumps (delete + recreate) on significant changes
   */
  async updateTaskList(
    sessionKey: string,
    content: string,
    channel: string,
    threadTs: string,
    shouldBump: boolean
  ): Promise<void> {
    const existing = this.taskListMessages.get(sessionKey);

    if (existing && shouldBump) {
      // Delete old message and create new one at bottom to "bump"
      try {
        await this.app.client.chat.delete({
          channel,
          ts: existing.ts,
        });
        this.logger.debug('Deleted task list message for bump', { sessionKey, ts: existing.ts });
      } catch (error) {
        this.logger.warn('Failed to delete task list message', error);
      }

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
        this.logger.debug('Created new task list message (bumped)', { sessionKey, ts: result.ts });
      }
    } else if (existing) {
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
   * Update or create a tool output message
   * Never bumps, always updates in place
   * Creates new window when interrupted by text
   */
  async updateToolOutput(
    sessionKey: string,
    toolContent: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    // Check if we need a new window (interrupted by text)
    if (this.currentWindow.get(sessionKey) === 'text') {
      this.logger.debug('Starting new tool window after text interruption', { sessionKey });
      this.toolOutputMessages.delete(sessionKey);
      this.accumulatedToolOutput.delete(sessionKey);
    }

    // Mark current window as tool
    this.currentWindow.set(sessionKey, 'tool');

    // Accumulate tool output
    const accumulated = this.accumulatedToolOutput.get(sessionKey) || [];
    accumulated.push(toolContent);
    this.accumulatedToolOutput.set(sessionKey, accumulated);

    // Format as code block
    const formattedOutput = '```\n' + accumulated.join('\n\n---\n\n') + '\n```';

    const existing = this.toolOutputMessages.get(sessionKey);

    if (existing) {
      // Update in place (never bump)
      try {
        await this.app.client.chat.update({
          channel,
          ts: existing.ts,
          text: formattedOutput,
        });
        existing.lastUpdated = new Date();
        this.logger.debug('Updated tool output message', { sessionKey, ts: existing.ts });
      } catch (error) {
        this.logger.warn('Failed to update tool message, creating new one', error);
        // If update fails, create new message
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: formattedOutput,
        });
        if (result.ts) {
          this.toolOutputMessages.set(sessionKey, {
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
        text: formattedOutput,
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
   * Marks window as text, which interrupts tool window
   */
  async postTextMessage(
    sessionKey: string,
    content: string,
    channel: string,
    threadTs: string
  ): Promise<void> {
    // Mark current window as text (interrupts tool window)
    this.currentWindow.set(sessionKey, 'text');

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
    this.currentWindow.delete(sessionKey);
    this.logger.debug('Cleaned up messages for session', { sessionKey });
  }
}
