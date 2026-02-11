import { Logger } from './logger.js';
import * as path from 'path';
import * as fs from 'fs';

const logger = new Logger('Storage');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const workingDirsPath = path.join(dataDir, 'working-directories.json');
const sessionsPath = path.join(dataDir, 'conversation-sessions.json');

logger.info('Initializing file-based storage', { dataDir });

export interface StoredWorkingDir {
  key: string;
  channel_id: string;
  thread_ts: string | null;
  user_id: string | null;
  directory: string;
  set_at: string;
  updated_at: string;
}

export interface StoredSession {
  session_key: string;
  user_id: string;
  channel_id: string;
  thread_ts: string | null;
  session_id: string | null;
  last_activity: string;
  created_at: string;
  updated_at: string;
}

// In-memory cache
let workingDirs: Record<string, StoredWorkingDir> = {};
let sessions: Record<string, StoredSession> = {};

// Load data from files on startup
function loadWorkingDirectories() {
  try {
    if (fs.existsSync(workingDirsPath)) {
      const data = fs.readFileSync(workingDirsPath, 'utf-8');
      workingDirs = JSON.parse(data);
      logger.info('Loaded working directories', { count: Object.keys(workingDirs).length });
    }
  } catch (error) {
    logger.error('Failed to load working directories', { error });
    workingDirs = {};
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(sessionsPath)) {
      const data = fs.readFileSync(sessionsPath, 'utf-8');
      sessions = JSON.parse(data);
      logger.info('Loaded sessions', { count: Object.keys(sessions).length });
    }
  } catch (error) {
    logger.error('Failed to load sessions', { error });
    sessions = {};
  }
}

// Atomic write helper
function writeJsonFile(filePath: string, data: any) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, filePath);
}

// Initialize
loadWorkingDirectories();
loadSessions();

export const storage = {
  // Working directory methods
  saveWorkingDirectory(key: string, channelId: string, directory: string, threadTs?: string, userId?: string) {
    const now = new Date().toISOString();
    workingDirs[key] = {
      key,
      channel_id: channelId,
      thread_ts: threadTs || null,
      user_id: userId || null,
      directory,
      set_at: workingDirs[key]?.set_at || now,
      updated_at: now,
    };
    writeJsonFile(workingDirsPath, workingDirs);
    logger.debug('Saved working directory', { key, channelId, directory });
  },

  getWorkingDirectory(key: string): StoredWorkingDir | undefined {
    const dir = workingDirs[key];
    if (dir) {
      logger.debug('Retrieved working directory', { key, directory: dir.directory });
    }
    return dir;
  },

  deleteWorkingDirectory(key: string): boolean {
    if (workingDirs[key]) {
      delete workingDirs[key];
      writeJsonFile(workingDirsPath, workingDirs);
      logger.debug('Deleted working directory', { key });
      return true;
    }
    return false;
  },

  listWorkingDirectories(): StoredWorkingDir[] {
    return Object.values(workingDirs).sort((a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  },

  // Session methods
  saveSession(sessionKey: string, userId: string, channelId: string, threadTs: string | undefined, sessionId: string | undefined) {
    const now = new Date().toISOString();
    const existing = sessions[sessionKey];

    sessions[sessionKey] = {
      session_key: sessionKey,
      user_id: userId,
      channel_id: channelId,
      thread_ts: threadTs || null,
      session_id: sessionId || null,
      last_activity: now,
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    writeJsonFile(sessionsPath, sessions);
    logger.debug('Saved session', { sessionKey, sessionId });
  },

  getSession(sessionKey: string): StoredSession | undefined {
    const session = sessions[sessionKey];
    if (session) {
      logger.debug('Retrieved session', { sessionKey, sessionId: session.session_id });
    }
    return session;
  },

  deleteSession(sessionKey: string): boolean {
    if (sessions[sessionKey]) {
      delete sessions[sessionKey];
      writeJsonFile(sessionsPath, sessions);
      logger.debug('Deleted session', { sessionKey });
      return true;
    }
    return false;
  },

  listSessions(): StoredSession[] {
    return Object.values(sessions).sort((a, b) =>
      new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime()
    );
  },

  cleanOldSessions(maxAgeMs: number = 14 * 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const keys = Object.keys(sessions);
    let cleaned = 0;

    for (const key of keys) {
      const session = sessions[key];
      const lastActivity = new Date(session.last_activity).getTime();
      if (now - lastActivity > maxAgeMs) {
        delete sessions[key];
        cleaned++;
      }
    }

    if (cleaned > 0) {
      writeJsonFile(sessionsPath, sessions);
      logger.info('Cleaned old sessions', { count: cleaned, maxAgeDays: maxAgeMs / (24 * 60 * 60 * 1000) });
    }
    return cleaned;
  },
};
