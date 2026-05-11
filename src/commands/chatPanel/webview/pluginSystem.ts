import { DiscussionCapabilities } from './dom';

export interface PluginContext {
    messageId: string;
    isFinal: boolean;
    capabilities: DiscussionCapabilities | null;
    vscode: any;
}

export interface TagPlugin {
    id: string;
    tagPattern: RegExp; // Global regex to find the tag
    
    // Logic to render the HTML string
    render: (match: RegExpExecArray, context: PluginContext) => string | null;
    
    // Logic to attach event listeners after DOM injection
    initialize?: (container: HTMLElement, context: PluginContext) => void;
    
    // Fragment to inject into the LLM system prompt
    systemPromptFragment?: string;
}

export const pluginRegistry: TagPlugin[] = [];

export function registerPlugin(plugin: TagPlugin) {
    pluginRegistry.push(plugin);
}