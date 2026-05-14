import fs from 'fs';
import path from 'path';
import { WSClient } from "@wecom/aibot-node-sdk";

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

export async function fetchImageAsBase64(bot: WSClient, url: string, aesKey?: string): Promise<string> {
  if (!url || !url.startsWith("http")) return url;
  
  try {
    const { buffer } = await bot.downloadFile(url, aesKey);
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.error(`Failed to fetch and decrypt image from ${url}:`, error);
    return url;
  }
}

export async function downloadMediaFile(bot: WSClient, url: string, aesKey?: string, fallbackExt: string = '.bin'): Promise<string> {
  if (!url || !url.startsWith("http")) return url;

  try {
    const { buffer, filename } = await bot.downloadFile(url, aesKey);
    
    const finalName = filename || `file_${Date.now()}${fallbackExt}`;
    const filepath = path.join(DOWNLOAD_DIR, finalName);
    
    fs.writeFileSync(filepath, buffer);
    return filepath;
  } catch (error) {
    console.error(`Failed to download and decrypt file from ${url}:`, error);
    return url;
  }
}
