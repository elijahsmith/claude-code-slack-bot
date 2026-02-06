import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger.js';
import { config } from './config.js';
import type { WebClient } from '@slack/web-api';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  size: number;
  tempPath?: string;
}

export class FileHandler {
  private logger = new Logger('FileHandler');
  private slackClient?: WebClient;

  setSlackClient(client: WebClient): void {
    this.slackClient = client;
  }

  async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
    const processedFiles: ProcessedFile[] = [];

    for (const file of files) {
      try {
        const processed = await this.downloadFile(file);
        if (processed) {
          processedFiles.push(processed);
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${file.name}`, error);
      }
    }

    return processedFiles;
  }

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      return null;
    }

    try {
      // If we have a Slack client and file ID, use files.info to get proper download URL
      let downloadUrl = file.url_private || file.url_private_download;
      let fileInfo = file;

      if (this.slackClient && file.id) {
        try {
          this.logger.debug('Fetching file info from Slack API', { fileId: file.id });
          const response = await this.slackClient.files.info({ file: file.id });
          if (response.ok && response.file) {
            fileInfo = response.file;
            downloadUrl = (fileInfo as any).url_private_download || (fileInfo as any).url_private;
            this.logger.debug('Got file info from API', {
              name: fileInfo.name,
              url_private_download: (fileInfo as any).url_private_download,
            });
          }
        } catch (error) {
          this.logger.warn('Failed to fetch file info, using event data', { fileId: file.id, error });
        }
      }

      this.logger.debug('Downloading file', {
        name: fileInfo.name,
        mimetype: fileInfo.mimetype,
        downloadUrl,
      });

      const response = await fetch(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${config.slack.botToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Check Content-Type to ensure we're not getting HTML
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
        this.logger.error('Received HTML instead of file content', {
          name: fileInfo.name,
          contentType,
          url: downloadUrl
        });
        throw new Error('Received HTML page instead of file content - check Slack file sharing permissions');
      }

      const buffer = await response.buffer();
      const tempDir = os.tmpdir();
      const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${fileInfo.name}`);

      fs.writeFileSync(tempPath, buffer);

      const processed: ProcessedFile = {
        path: tempPath,
        name: fileInfo.name,
        mimetype: fileInfo.mimetype,
        isImage: this.isImageFile(fileInfo.mimetype),
        isText: this.isTextFile(fileInfo.mimetype),
        size: fileInfo.size,
        tempPath,
      };

      this.logger.info('File downloaded successfully', {
        name: fileInfo.name,
        tempPath,
        isImage: processed.isImage,
        isText: processed.isText,
      });

      return processed;
    } catch (error) {
      this.logger.error('Failed to download file', error);
      return null;
    }
  }

  private isImageFile(mimetype: string): boolean {
    return mimetype.startsWith('image/');
  }

  private isTextFile(mimetype: string): boolean {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
    ];

    return textTypes.some(type => mimetype.startsWith(type));
  }

  async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
    let prompt = userText || 'Please analyze the uploaded files.';
    
    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';
      
      for (const file of files) {
        if (file.isImage) {
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Path: ${file.path}\n`;
          prompt += `Note: This is an image file that has been uploaded. You can analyze it using the Read tool to examine the image content.\n`;
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          
          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
            } else {
              prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch (error) {
            prompt += `Error reading file content: ${error}\n`;
          }
        } else {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: This is a binary file. Content analysis may be limited.\n`;
        }
      }
      
      prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
    }

    return prompt;
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    for (const file of files) {
      if (file.tempPath) {
        try {
          fs.unlinkSync(file.tempPath);
          this.logger.debug('Cleaned up temp file', { path: file.tempPath });
        } catch (error) {
          this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
        }
      }
    }
  }

  getSupportedFileTypes(): string[] {
    return [
      'Images: jpg, png, gif, webp, svg',
      'Text files: txt, md, json, js, ts, py, java, etc.',
      'Documents: pdf, docx (limited support)',
      'Code files: most programming languages',
    ];
  }
}