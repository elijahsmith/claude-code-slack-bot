import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Load system prompt from .system-prompt.md file if it exists
function loadSystemPrompt(): string {
  const promptPath = path.join(process.cwd(), '.system-prompt.md');
  try {
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8').trim();
    }
  } catch (error) {
    console.warn(`Warning: Could not read system prompt file: ${error}`);
  }
  return '';
}

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  systemPrompt: loadSystemPrompt(),
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}