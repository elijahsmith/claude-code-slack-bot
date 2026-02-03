import * as fs from 'fs';
import { Logger } from './logger.js';

export class ImageHandler {
  private logger = new Logger('ImageHandler');

  async convertImageToBase64(imagePath: string, mimetype: string): Promise<string | null> {
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      return `data:${mimetype};base64,${base64Image}`;
    } catch (error) {
      this.logger.error('Failed to convert image to base64', error);
      return null;
    }
  }

  formatImagePrompt(imagePath: string, filename: string, mimetype: string, userText: string): string {
    let prompt = userText || 'Please analyze this image.';
    
    prompt += `\n\nImage: ${filename}\n`;
    prompt += `Type: ${mimetype}\n`;
    prompt += `Note: Please analyze this image and provide insights about what you see.\n`;
    
    return prompt;
  }

  isImageSupported(mimetype: string): boolean {
    const supportedTypes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp'
    ];
    
    return supportedTypes.includes(mimetype.toLowerCase());
  }
}