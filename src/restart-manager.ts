import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

const RESTART_MARKER_PATH = '/control/restart-session.json';
const RESTART_REQUEST_PATH = '/control/restart-request.json';
const RESTART_LOG_PATH = '/control/restart-log.txt';

export interface RestartSession {
  channel: string;
  threadTs?: string;
  messageTs?: string; // Original message ts (needed to reconstruct session key for DMs)
  userId: string;
  sessionKey: string;
  timestamp: string;
  reason?: string;
}

export interface RestartRequest {
  reason: string;
  timestamp: string;
  userId?: string;
}

export class RestartManager {
  private logger = new Logger('RestartManager');

  /**
   * Write all active sessions to the restart marker file so they can be
   * resumed after the process restarts. Replaces any previous marker.
   */
  markActiveSessions(sessions: RestartSession[], reason?: string): void {
    try {
      fs.writeFileSync(RESTART_MARKER_PATH, JSON.stringify(sessions, null, 2));

      // Append to log file (for audit trail)
      const ts = new Date().toISOString();
      const logEntry = `${ts} | sessions:${sessions.length} | ${reason || 'Process shutdown'}\n`;
      fs.appendFileSync(RESTART_LOG_PATH, logEntry, 'utf-8');

      this.logger.info('Marked active sessions for restart', {
        count: sessions.length,
        sessionKeys: sessions.map(s => s.sessionKey),
        reason: reason || 'Process shutdown',
      });
    } catch (error) {
      this.logger.error('Failed to write restart marker', error);
    }
  }

  /**
   * Read all pending restart sessions and delete the marker file.
   */
  getPendingRestarts(): RestartSession[] {
    try {
      if (!fs.existsSync(RESTART_MARKER_PATH)) {
        return [];
      }

      const data = fs.readFileSync(RESTART_MARKER_PATH, 'utf-8');
      const parsed = JSON.parse(data);

      // Delete the marker file after reading
      fs.unlinkSync(RESTART_MARKER_PATH);

      // Handle both old single-object format and new array format
      const sessions: RestartSession[] = Array.isArray(parsed) ? parsed : [parsed];

      this.logger.info('Found pending restart sessions', {
        count: sessions.length,
        sessionKeys: sessions.map(s => s.sessionKey),
      });
      return sessions;
    } catch (error) {
      this.logger.error('Failed to read restart marker', error);
      return [];
    }
  }

  /**
   * Clear any pending restart marker
   */
  clearRestart(): void {
    try {
      if (fs.existsSync(RESTART_MARKER_PATH)) {
        fs.unlinkSync(RESTART_MARKER_PATH);
        this.logger.info('Cleared restart marker');
      }
    } catch (error) {
      this.logger.error('Failed to clear restart marker', error);
    }
  }

  /**
   * Enrich the restart-request.json with the Slack userId who triggered it.
   * Called by slack-handler when it detects a restart-bot command.
   */
  requestRestart(userId: string, reason: string): void {
    try {
      const request: RestartRequest = {
        reason,
        timestamp: new Date().toISOString(),
        userId,
      };
      fs.writeFileSync(RESTART_REQUEST_PATH, JSON.stringify(request, null, 2));
      this.logger.info('Wrote restart request', { userId, reason });
    } catch (error) {
      this.logger.error('Failed to write restart request', error);
    }
  }

  /**
   * Read the structured restart request file (written by restart-bot script
   * and enriched by requestRestart). Returns null if no file exists.
   * Deletes the file after reading.
   */
  readRestartRequest(): RestartRequest | null {
    try {
      if (!fs.existsSync(RESTART_REQUEST_PATH)) {
        return null;
      }

      const data = fs.readFileSync(RESTART_REQUEST_PATH, 'utf-8');
      const request: RestartRequest = JSON.parse(data);

      fs.unlinkSync(RESTART_REQUEST_PATH);

      this.logger.info('Read restart request', request);
      return request;
    } catch (error) {
      this.logger.error('Failed to read restart request', error);
      return null;
    }
  }

  /**
   * Get the last restart info — prefers the structured request file,
   * falls back to the log file.
   */
  getLastRestartInfo(): { timestamp: string; userId: string; reason: string } | null {
    // Try the structured request file first
    const request = this.readRestartRequest();
    if (request) {
      return {
        timestamp: request.timestamp,
        userId: request.userId || '',
        reason: request.reason,
      };
    }

    // Fall back to parsing the log file
    try {
      if (!fs.existsSync(RESTART_LOG_PATH)) {
        return null;
      }

      const data = fs.readFileSync(RESTART_LOG_PATH, 'utf-8');
      const lines = data.trim().split('\n');

      if (lines.length === 0 || !lines[lines.length - 1]) {
        return null;
      }

      const lastLine = lines[lines.length - 1];
      const parts = lastLine.split(' | ');

      if (parts.length < 3) {
        return null;
      }

      return {
        timestamp: parts[0],
        userId: '',
        reason: parts[2],
      };
    } catch (error) {
      this.logger.error('Failed to read restart log', error);
      return null;
    }
  }
}
