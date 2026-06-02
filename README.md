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

Start the read-only API in dev mode:

```bash
npm run api:dev
```

Build + run production:

```bash
npm run build
npm start
npm run api:start
```

## Slash commands

- `/ping`
- `/record start`
- `/record stop`
- `/record status`

## API

The API reads the same SQLite database as the bot. By default it listens at `http://localhost:3001`; override with `API_HOST`, `API_PORT`, or `DATABASE_PATH`.

Endpoints:

- `GET /api/health`
- `GET /api/meetings`
- `GET /api/meetings/:meetingId`
- `GET /api/meetings/:meetingId/transcript`

## Data

- SQLite DB: `data/`
- Audio segments: `recordings/`

Keep these folders private: they contain sensitive recordings/transcripts.

## Docker (optional)

Use Docker if you want a containerized runtime with persisted local data.

1. Make sure `.env` is filled in. `compose.yml` reads it directly.
2. Start the bot and API:

```bash
docker compose up -d --build
```

3. Follow logs:

```bash
docker compose logs -f
```

4. Stop it:

```bash
docker compose down
```

The compose file mounts `./data` and `./recordings` into the bot container, so SQLite data and audio files stay on the host. The API container mounts `./data` read-only.

## Notes

- Recording controls are limited to `ALLOWED_DISCORD_USER_IDS`.
- Recordings auto-stop when the active Stage is ended, after `RECORDING_MAX_DURATION_MS`, or after `RECORDING_IDLE_STOP_MS` with no active speakers. Set either duration value to `0` to disable that guard.
- Recording start, manual stop, and auto-stop completion messages post in the Stage chat.
