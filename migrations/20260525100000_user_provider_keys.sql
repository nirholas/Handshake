-- User BYOK provider keys (encrypted at rest with AES-256-GCM).
-- Stores encrypted blobs keyed by provider name: { "anthropic": "<b64>", "openai": "<b64>" }
-- Platform-provided providers (openrouter, groq) are never stored here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_keys JSONB NOT NULL DEFAULT '{}';
