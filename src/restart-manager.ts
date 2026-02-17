import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

const RESTART_MARKER_PATH = '/control/restart-session.json';
const RESTART_LOG_PATH = '/control/restart-log.txt';

export interface RestartSession {
  channel: string;
  threadTs?: string;
  userId: string;
  sessionKey: string;
  timestamp: string;
  reason?: string; // Optional reason for the restart
}

export class RestartManager {
  private logger = new Logger('RestartManager');

  /**
   * Mark a session as requesting a restart and log it
   */
  markRestart(session: RestartSession, reason?: string): void {
    try {
      // Add reason to session if provided
      const sessionWithReason = { ...session, reason };

      // Write to marker file (for immediate restart detection)
      fs.writeFileSync(RESTART_MARKER_PATH, JSON.stringify(sessionWithReason, null, 2));

      // Append to log file (for audit trail)
      const logEntry = `${session.timestamp} | user:${session.userId} | ${reason || 'Manual restart'}\n`;
      fs.appendFileSync(RESTART_LOG_PATH, logEntry, 'utf-8');

      this.logger.info('Marked session for restart notification', {
        sessionKey: session.sessionKey,
        reason: reason || 'Manual restart'
      });
    } catch (error) {
      this.logger.error('Failed to write restart marker', error);
    }
  }

  /**
   * Check if there's a pending restart session and return it
   */
  getPendingRestart(): RestartSession | null {
    try {
      if (!fs.existsSync(RESTART_MARKER_PATH)) {
        return null;
      }

      const data = fs.readFileSync(RESTART_MARKER_PATH, 'utf-8');
      const session = JSON.parse(data) as RestartSession;

      // Delete the marker file after reading
      fs.unlinkSync(RESTART_MARKER_PATH);

      this.logger.info('Found pending restart session', { sessionKey: session.sessionKey });
      return session;
    } catch (error) {
      this.logger.error('Failed to read restart marker', error);
      return null;
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
   * Get the last restart log entry
   */
  getLastRestartInfo(): { timestamp: string; userId: string; reason: string } | null {
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
      // Format: 2026-02-17T14:45:32Z | user:U12345 | Reason text
      const parts = lastLine.split(' | ');

      if (parts.length < 3) {
        return null;
      }

      return {
        timestamp: parts[0],
        userId: parts[1].replace('user:', ''),
        reason: parts[2],
      };
    } catch (error) {
      this.logger.error('Failed to read restart log', error);
      return null;
    }
  }
}
