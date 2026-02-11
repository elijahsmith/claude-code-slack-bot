import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

const RESTART_MARKER_PATH = '/control/restart-session.json';

export interface RestartSession {
  channel: string;
  threadTs?: string;
  userId: string;
  sessionKey: string;
  timestamp: string;
}

export class RestartManager {
  private logger = new Logger('RestartManager');

  /**
   * Mark a session as requesting a restart
   */
  markRestart(session: RestartSession): void {
    try {
      fs.writeFileSync(RESTART_MARKER_PATH, JSON.stringify(session, null, 2));
      this.logger.info('Marked session for restart notification', { sessionKey: session.sessionKey });
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
}
