import * as lark from '@larksuiteoapi/node-sdk';
import { Logger } from '../utils/logger.js';

export class FeishuBot {
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private log: Logger;
  private lastChatId: string | null = null;
  private allowedUserIds: string[];
  private messageHandler: ((text: string, chatId: string, userId: string) => Promise<void>) | null = null;

  constructor(
    appId: string,
    appSecret: string,
    allowedUserIds: string[],
    log: Logger,
  ) {
    this.log = log;
    this.allowedUserIds = allowedUserIds;

    // Create API Client for sending messages
    this.client = new lark.Client({ appId, appSecret });

    // Create event dispatcher for receiving messages
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    // Create WebSocket long connection client
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });
  }

  /**
   * Set the handler for incoming messages.
   */
  setMessageHandler(handler: (text: string, chatId: string, userId: string) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Start the WebSocket connection to Feishu.
   */
  async start(): Promise<void> {
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.log.info('Feishu Bot connected via WebSocket');
  }

  /**
   * Get the last chat ID that sent a message (for push notifications).
   */
  getLastChatId(): string | null {
    return this.lastChatId;
  }

  /**
   * Send a text message to a chat.
   */
  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      this.log.error(`Failed to send text message: ${err}`);
    }
  }

  /**
   * Send an image message to a chat.
   */
  async sendImage(chatId: string, imageBuffer: Buffer): Promise<void> {
    try {
      // Upload image first
      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: new Blob([new Uint8Array(imageBuffer)]) as any,
        },
      });

      const imageKey = (uploadResp as any)?.data?.image_key;
      if (!imageKey) {
        this.log.error('Failed to upload image: no image_key returned');
        await this.sendText(chatId, '❌ Failed to upload screenshot');
        return;
      }

      // Send image message
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
    } catch (err) {
      this.log.error(`Failed to send image: ${err}`);
      await this.sendText(chatId, '❌ Failed to send screenshot');
    }
  }

  /**
   * Send an interactive card message to a chat.
   * Card JSON string should be pre-built by card-builder.ts
   */
  async sendCard(chatId: string, cardJson: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      });
    } catch (err) {
      this.log.error(`Failed to send card: ${err}`);
      // Fallback to plain text
      try {
        const card = JSON.parse(cardJson);
        const fallbackText = card.elements
          ?.filter((e: any) => e.tag === 'markdown')
          .map((e: any) => e.content)
          .join('\n\n') || 'Card rendering failed';
        await this.sendText(chatId, fallbackText);
      } catch {
        await this.sendText(chatId, '❌ Failed to render card');
      }
    }
  }

  /**
   * Handle incoming messages from Feishu.
   */
  private async handleMessage(data: any): Promise<void> {
    try {
      const message = data.message;
      const msgType = message.message_type;
      const chatId = message.chat_id;
      const senderId = data.sender?.sender_id?.open_id || '';

      this.lastChatId = chatId;

      // Only process text messages
      if (msgType !== 'text') {
        await this.sendText(chatId, '⚠️ Only text messages are supported.');
        return;
      }

      // Check user whitelist
      if (this.allowedUserIds.length > 0 && !this.allowedUserIds.includes(senderId)) {
        this.log.warn(`Unauthorized user: ${senderId}`);
        await this.sendText(chatId, '🚫 Unauthorized. Your user ID is not in the allowlist.');
        return;
      }

      // Parse message content
      const content = JSON.parse(message.content);
      let text = content.text || '';

      // Remove @bot mention prefix if present
      text = text.replace(/@_user_\d+\s*/g, '').trim();

      if (!text) return;

      this.log.info(`Message from ${senderId}: ${text.substring(0, 50)}`);

      // Route to handler
      if (this.messageHandler) {
        await this.messageHandler(text, chatId, senderId);
      }
    } catch (err) {
      this.log.error(`Failed to handle message: ${err}`);
    }
  }
}
