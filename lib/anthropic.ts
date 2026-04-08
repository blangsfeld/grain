import Anthropic from "@anthropic-ai/sdk";

export function getAnthropicClient(timeout = 600000): Anthropic {
  // GRAIN_ANTHROPIC_KEY avoids collision with SDK's auto-detection of ANTHROPIC_API_KEY
  const key = process.env.GRAIN_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error("No Anthropic API key found. Set GRAIN_ANTHROPIC_KEY in .env.local");
  }
  return new Anthropic({ apiKey: key.trim(), timeout });
}
