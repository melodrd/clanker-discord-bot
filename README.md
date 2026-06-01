# lituus-bot

Simple Discord Stage recorder bot.

It joins a Stage channel, records each speaker into `.ogg` files, transcribes each finished segment with Deepgram, and stores metadata/transcripts in SQLite.

Discord invite permission string: `1133568` (this is the decimal bitmask used in the invite URL `permissions=` param, defining what the bot can do).

## Requirements

- Node.js `22.x`
- Discord bot token + app/client ID + guild ID
- Deepgram API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Fill `.env`:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DEEPGRAM_API=
ALLOWED_DISCORD_USER_IDS=123456789012345678,234567890123456789
RECORDING_MAX_DURATION_MS=14400000
RECORDING_IDLE_STOP_MS=900000
```

## Run

Register slash commands once:

```bash
npm run commands:register
```

Start in dev mode:

```bash
npm run dev
```

Build + run production:

```bash
npm run build
npm start
```

## Slash commands

- `/ping`
- `/record start`
- `/record stop`
- `/record status`

## Data

- SQLite DB: `data/`
- Audio segments: `recordings/`

Keep these folders private: they may contain sensitive recordings/transcripts.

## Docker (optional)

```bash
docker compose up -d --build
```

## Notes

- Recording controls are limited to `ALLOWED_DISCORD_USER_IDS`.
- Recordings auto-stop after `RECORDING_MAX_DURATION_MS` or after `RECORDING_IDLE_STOP_MS` with no active speakers. Set either value to `0` to disable that guard.
- Auto-stopped sessions reuse the normal stop/finalization path and DM the user who started the recording when completion finishes.
