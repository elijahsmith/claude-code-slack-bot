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

// Parse allowed tools from env var
// Format: "Read,Edit,Write,Bash:git *,Bash:npm *"
// Supports glob patterns for Bash commands
function parseAllowedTools(): string[] {
  const toolsEnv = process.env.ALLOWED_TOOLS || '';
  if (!toolsEnv.trim()) {
    // Default: allow common file operations and safe commands
    return ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'Bash:git *', 'Bash:npm *', 'Bash:npx *', 'Bash:bd *', 'Bash:glab *'];
  }
  return toolsEnv.split(',').map(t => t.trim()).filter(Boolean);
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
  allowedTools: parseAllowedTools(),
};

// Check if a tool invocation is allowed by the allowlist
// Supports patterns like "Bash:git *" to match "Bash" tool with command starting with "git "
export function isToolAllowed(toolName: string, input: Record<string, unknown>): boolean {
  for (const pattern of config.allowedTools) {
    // Simple tool name match (e.g., "Read", "Edit")
    if (pattern === toolName) {
      return true;
    }

    // Pattern match for Bash commands (e.g., "Bash:git *")
    if (pattern.startsWith('Bash:') && toolName === 'Bash') {
      const cmdPattern = pattern.slice(5); // Remove "Bash:" prefix
      const command = (input.command as string) || '';

      if (cmdPattern.endsWith(' *')) {
        // Prefix match: "git *" matches "git status", "git commit", etc.
        const prefix = cmdPattern.slice(0, -2); // Remove " *"
        if (command.startsWith(prefix + ' ') || command === prefix) {
          return true;
        }
      } else if (cmdPattern === command) {
        // Exact match
        return true;
      }
    }

    // Pattern match for MCP tools (e.g., "mcp__*" to allow all MCP tools)
    if (pattern === 'mcp__*' && toolName.startsWith('mcp__')) {
      return true;
    }
  }

  return false;
}

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