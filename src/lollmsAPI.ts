import fetch from 'node-fetch';

export interface LollmsConfig {
  apiUrl: string;
  apiKey: string;
}

// Example message structure for chat
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class LollmsAPI {
  private apiUrl: string;
  private apiKey: string;

  constructor(config: LollmsConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  // Sends a chat completion request to Lollms backend
  async sendChat(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Example model name, adjustable
        messages: messages
      })
    });

    if (!response.ok) {
      throw new Error(`Lollms API error: ${response.statusText}`);
    }

    const data = await response.json();

    // Adjust parsing according to actual Lollms response schema
    return data.choices?.[0]?.message?.content || '';
  }
}
