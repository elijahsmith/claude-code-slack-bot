import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';

export type McpStdioServerConfig = {
  type?: 'stdio'; // Optional for backwards compatibility
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

export interface McpConfiguration {
  mcpServers: Record<string, McpServerConfig>;
}

export class McpManager {
  private logger = new Logger('McpManager');
  private config: McpConfiguration | null = null;
  private configPath: string;

  constructor(configPath: string = './mcp-servers.json') {
    this.configPath = path.resolve(configPath);
  }

  loadConfiguration(): McpConfiguration | null {
    if (this.config) {
      return this.config;
    }

    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('No MCP configuration file found', { path: this.configPath });
        return null;
      }

      const configContent = fs.readFileSync(this.configPath, 'utf-8');
      const parsedConfig = JSON.parse(configContent);

      if (!parsedConfig.mcpServers || typeof parsedConfig.mcpServers !== 'object') {
        this.logger.warn('Invalid MCP configuration: missing or invalid mcpServers', { path: this.configPath });
        return null;
      }

      // Validate server configurations
      for (const [serverName, serverConfig] of Object.entries(parsedConfig.mcpServers)) {
        if (!this.validateServerConfig(serverName, serverConfig as McpServerConfig)) {
          this.logger.warn('Invalid server configuration, skipping', { serverName });
          delete parsedConfig.mcpServers[serverName];
        }
      }

      this.config = parsedConfig as McpConfiguration;
      
      this.logger.info('Loaded MCP configuration', {
        path: this.configPath,
        serverCount: Object.keys(this.config.mcpServers).length,
        servers: Object.keys(this.config.mcpServers),
      });

      return this.config;
    } catch (error) {
      this.logger.error('Failed to load MCP configuration', error);
      return null;
    }
  }

  private validateServerConfig(serverName: string, config: McpServerConfig): boolean {
    if (!config || typeof config !== 'object') {
      return false;
    }

    // Validate based on type
    if (!config.type || config.type === 'stdio') {
      // Stdio server
      const stdioConfig = config as McpStdioServerConfig;
      if (!stdioConfig.command || typeof stdioConfig.command !== 'string') {
        this.logger.warn('Stdio server missing command', { serverName });
        return false;
      }
    } else if (config.type === 'sse' || config.type === 'http') {
      // SSE or HTTP server
      const urlConfig = config as McpSSEServerConfig | McpHttpServerConfig;
      if (!urlConfig.url || typeof urlConfig.url !== 'string') {
        this.logger.warn('SSE/HTTP server missing URL', { serverName, type: config.type });
        return false;
      }
    } else {
      this.logger.warn('Unknown server type', { serverName, type: config.type });
      return false;
    }

    return true;
  }

  getServerConfiguration(): Record<string, McpServerConfig> | undefined {
    const config = this.loadConfiguration();
    return config?.mcpServers;
  }

  getDefaultAllowedTools(): string[] {
    const config = this.loadConfiguration();
    if (!config) {
      return [];
    }

    // Allow all tools from all configured servers by default
    return Object.keys(config.mcpServers).map(serverName => `mcp__${serverName}`);
  }

  formatMcpInfo(): string {
    const config = this.loadConfiguration();
    if (!config || Object.keys(config.mcpServers).length === 0) {
      return 'No MCP servers configured.';
    }

    let info = '🔧 **MCP Servers Configured:**\n\n';
    
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      const type = serverConfig.type || 'stdio';
      info += `• **${serverName}** (${type})\n`;
      
      if (type === 'stdio') {
        const stdioConfig = serverConfig as McpStdioServerConfig;
        info += `  Command: \`${stdioConfig.command}\`\n`;
        if (stdioConfig.args && stdioConfig.args.length > 0) {
          info += `  Args: \`${stdioConfig.args.join(' ')}\`\n`;
        }
      } else {
        const urlConfig = serverConfig as McpSSEServerConfig | McpHttpServerConfig;
        info += `  URL: \`${urlConfig.url}\`\n`;
      }
      info += '\n';
    }

    info += 'Available tools follow the pattern: `mcp__serverName__toolName`\n';
    info += 'All MCP tools are allowed by default.';

    return info;
  }

  reloadConfiguration(): McpConfiguration | null {
    this.config = null;
    return this.loadConfiguration();
  }
}