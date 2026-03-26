import { ToolDefinition, ToolExecutionEnv } from '../tool';
import fetch from 'node-fetch';

export const extractYoutubeTranscriptTool: ToolDefinition = {
    name: "extract_youtube_transcript",
    description: "Extracts the transcript/captions from a YouTube video or Short. Tries multiple formats and provides detailed debug info.",
    isAgentic: true,
    isDefault: true,
    parameters: [
        { name: "url", type: "string", description: "The full URL of the YouTube video or Short.", required: true },
        { name: "language", type: "string", description: "ISO 639-1 language code (e.g., 'en', 'fr'). Defaults to 'en'.", required: false },
        { name: "force_format", type: "string", description: "Force 'xml' or 'json3' if one fails.", required: false },
        { name: "use_whisper", type: "boolean", description: "Placeholder for audio-based transcription (Agentic fallback).", required: false }
    ],
    async execute(params: { url: string, language?: string, force_format?: 'xml' | 'json3', use_whisper?: boolean }, env: ToolExecutionEnv, signal: AbortSignal): Promise<{ success: boolean; output: string; }> {
        if (!params.url) return { success: false, output: "Error: URL is required." };

        // Agent requested a fallback we don't handle natively in this JS tool
        if (params.use_whisper) {
            return { success: false, output: "LOCAL TOOL ERROR: Whisper-based transcription is not available in the native JS tool. Please use the 'yt-dlp' Python strategy instead." };
        }

        const videoId = extractVideoId(params.url);
        if (!videoId) return { success: false, output: `Could not parse video ID from: ${params.url}` };

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.youtube.com/'
        };

        try {
            // 1. Fetch Video Page to get API Key and metadata
            const url = params.url.includes('/shorts/') ? params.url : `https://www.youtube.com/watch?v=${videoId}`;
            const pageRes = await fetch(url, { headers, signal: signal as any });
            if (!pageRes.ok) return { success: false, output: `YouTube Fetch Failed: HTTP ${pageRes.status}` };
            const html = await pageRes.text();

            // 2. Extract InnerTube API Key
            const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
            if (!apiKeyMatch) return { success: false, output: "Could not find InnerTube API key. YouTube may have blocked the request." };
            const apiKey = apiKeyMatch[1];

            // 3. Extract ytInitialData for the continuation token
            const dataMatch = html.match(/var ytInitialData = ({.*?});/s);
            if (!dataMatch) return { success: false, output: "Could not find video data (ytInitialData) on the page." };
            const ytData = JSON.parse(dataMatch[1]);

            // 4. Find the transcript token (params) recursively
            const findTranscriptParams = (obj: any): string | null => {
                if (!obj || typeof obj !== 'object') return null;
                if (obj.getTranscriptEndpoint && obj.getTranscriptEndpoint.params) return obj.getTranscriptEndpoint.params;
                for (const key of Object.keys(obj)) {
                    const result = findTranscriptParams(obj[key]);
                    if (result) return result;
                }
                return null;
            };

            const transcriptParams = findTranscriptParams(ytData);
            if (!transcriptParams) return { success: false, output: "Transcripts are not available for this video." };

            // 5. POST to InnerTube get_transcript endpoint
            const transcriptRes = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({
                    context: { 
                        client: { 
                            clientName: "WEB", 
                            clientVersion: "2.20240325.01.00",
                            hl: params.language || "en",
                            originalUrl: url
                        } 
                    },
                    params: transcriptParams
                }),
                signal: signal as any
            });

            if (!transcriptRes.ok) return { success: false, output: `InnerTube API Error: HTTP ${transcriptRes.status}` };
            const transcriptData: any = await transcriptRes.json();

            // 6. Parse segments from the response (Resilient to layout changes)
            let segments = [];
            const action = transcriptData.actions?.find((a: any) => a.updateEngagementPanelAction);
            if (action) {
                segments = action.updateEngagementPanelAction.content?.transcriptRenderer?.body?.transcriptBodyRenderer?.cueGroups || [];
            } else {
                segments = transcriptData.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer?.cueGroups || [];
            }

            const textParts: string[] = [];
            for (const group of segments) {
                const cues = group.transcriptCueGroupRenderer?.cues || [];
                for (const cue of cues) {
                    const r = cue.transcriptCueRenderer;
                    const text = r?.cue?.simpleText || r?.cue?.label || "";
                    if (text) textParts.push(text);
                }
            }

            const finalResult = textParts.join(' ').replace(/\s+/g, ' ').trim();
            if (!finalResult) return { success: false, output: "Transcript found but extraction returned no text." };

            return { success: true, output: finalResult };

        } catch (e: any) {
            return { success: false, output: `Extraction Failed: ${e.message}` };
        }
    }
};

function extractVideoId(url: string): string | null {
    const patterns = [
        /(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([^#&?]*)/,
        /[?&]v=([^#&?]*)/
    ];
    for (const p of patterns) {
        const match = url.match(p);
        if (match && match[1] && match[1].length === 11) return match[1];
    }
    return null;
}
