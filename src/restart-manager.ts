import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

const RESTART_MARKER_PATH = '/control/restart-session.json';
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
      // Format: 2026-02-17T14:45:32Z | sessions:N | Reason text
      const parts = lastLine.split(' | ');

      if (parts.length < 3) {
        return null;
      }

      return {
        timestamp: parts[0],
        userId: parts[1].replace('user:', '').replace('sessions:', ''),
        reason: parts[2],
      };
    } catch (error) {
      this.logger.error('Failed to read restart log', error);
      return null;
    }
  }
}
