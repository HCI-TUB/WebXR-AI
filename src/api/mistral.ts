// Thin client for the Mistral REST API used by the app: audio transcription
// (Voxtral) and chat completions — streaming for the vision Q&A flow, plain
// (non-streaming) for the object-generation flow. The API key is read from
// VITE_MISTRAL_API_KEY at build time (see CLAUDE.md > Required environment).
//
// Why the offline transcription POST, not realtime Voxtral: browsers can't set
// the Authorization header the realtime WebSocket needs (verified), so the WS
// is out; a plain fetch with the header works client-side with no proxy.

const API_BASE = "https://api.mistral.ai/v1";
const AUTH = `Bearer ${import.meta.env.VITE_MISTRAL_API_KEY}`;

// Model ids. The `-latest` aliases track Mistral's newest release in each
// family, so these stay current without code changes.
export const TRANSCRIBE_MODEL = "voxtral-mini-latest";
export const CHAT_MODEL = "mistral-medium-latest"; // vision Q&A flow (multimodal)
export const OBJECT_MODEL = "devstral-medium-latest"; // object-generation flow

// A chat message. `content` is either plain text or, for multimodal turns, an
// array of content parts (e.g. a text part plus an image_url part).
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

/** Send a recorded clip to Voxtral; returns the transcribed text ("" on error). */
export async function transcribe(blob: Blob): Promise<string> {
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("file", blob, `prompt.${ext}`);

  const res = await fetch(`${API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: AUTH },
    body: form,
  });
  if (!res.ok) {
    console.error("Transcription failed:", res.status, await res.text());
    return "";
  }
  const json = await res.json();
  return (json.text ?? "").trim();
}

/** Non-streaming chat completion; resolves with the assistant's full reply. */
export async function chat(
  messages: ChatMessage[],
  model: string,
  maxTokens = 800,
): Promise<string> {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    console.error("Chat failed:", res.status, await res.text());
    return "";
  }
  const json = await res.json();
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Streaming chat completion. Invokes `onDelta` with the accumulated text after
 * each SSE chunk (so callers can render the reply live) and resolves with the
 * full reply once the stream ends.
 */
export async function streamChat(
  messages: ChatMessage[],
  model: string,
  onDelta: (accumulated: string) => void,
  maxTokens = 500,
): Promise<string> {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true }),
  });

  const reader = res.body?.getReader();
  let result = "";
  if (!reader) return result;

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder
      .decode(value)
      .split("\n\n")
      .filter((l) => l.trim().startsWith("data: "));
    for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data).choices?.[0]?.delta?.content;
        if (chunk) {
          result += chunk;
          onDelta(result);
        }
      } catch (e) {
        console.error("Stream parsing error:", e);
      }
    }
  }
  return result;
}
