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

        // Consistent browser-like User-Agent
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        try {
            // 1. Fetch Video Page
            const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers, signal: signal as any });
            if (!pageRes.ok) return { success: false, output: `YouTube Page Fetch Failed: HTTP ${pageRes.status}` };
            const html = await pageRes.text();

            // 2. Extract Player Config
            const jsonMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
            if (!jsonMatch) {
                if (html.includes('class="g-recaptcha"')) return { success: false, output: "BOT DETECTION: YouTube blocked the request with a Captcha." };
                return { success: false, output: "DATA ERROR: Could not find player response data (video may be private or restricted)." };
            }

            const playerResponse = JSON.parse(jsonMatch[1]);
            const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

            if (!captions || captions.length === 0) {
                return { success: false, output: "AVAILABILITY ERROR: No caption tracks found. This video might not have transcripts." };
            }

            // 3. Find requested language or fallback to first available
            const requestedLang = params.language || 'en';
            let track = captions.find((t: any) => t.languageCode === requestedLang);
            if (!track) {
                track = captions[0];
            }
            const baseUrl = track.baseUrl;

            // 4. Try JSON3 format first (cleanest)
            let resultText = "";
            let json3Status = "not attempted";

            if (params.force_format !== 'xml') {
                try {
                    const json3Res = await fetch(`${baseUrl}&fmt=json3`, { headers, signal: signal as any });
                    json3Status = `HTTP ${json3Res.status}`;
                    if (json3Res.ok) {
                        const json = await json3Res.json();
                        resultText = json.events
                            ?.filter((e: any) => e.segs)
                            ?.map((e: any) => e.segs.map((s: any) => s.utf8).join(''))
                            ?.join(' ') || "";
                    }
                } catch (e: any) {
                    json3Status = `Error: ${e.message}`;
                }
            }

            // 5. Fallback to XML
            if (!resultText) {
                const xmlRes = await fetch(baseUrl, { headers, signal: signal as any });
                if (xmlRes.ok) {
                    const xml = await xmlRes.text();
                    const parts: string[] = [];
                    const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
                    let m;
                    while ((m = regex.exec(xml)) !== null) {
                        parts.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
                    }
                    resultText = parts.join(' ');
                }

                if (!resultText) {
                    return { 
                        success: false, 
                        output: `TRANSCRIPT ERROR: Server returned 0 bytes for all formats.\n\nDebug Info:\n- JSON3 Attempt: ${json3Status}\n- XML Attempt: HTTP ${xmlRes.status}\n- Video ID: ${videoId}\n- Hint: YouTube likely blocked the IP or session headers.` 
                    };
                }
            }

            return { success: true, output: resultText.replace(/\s+/g, ' ').trim() };

        } catch (e: any) {
            return { success: false, output: `CRITICAL ERROR: ${e.message}` };
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
