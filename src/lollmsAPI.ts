import fetch from 'node-fetch';

export interface LollmsConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
}

// Example message structure for chat
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class LollmsAPI {
  private apiUrl: string;
  private apiKey: string;
  private modelName: string;

  constructor(config: LollmsConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.modelName = config.modelName
  }

  // Sends a chat completion request to Lollms backend
  async sendChat(messages: ChatMessage[]): Promise<string> {
    console.log(this.apiUrl)
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
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
