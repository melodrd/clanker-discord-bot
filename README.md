# lituus-discord-bot

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

Keep these folders private: they contain sensitive recordings/transcripts.

## Docker (optional)

Use Docker if you want a containerized runtime with persisted local data.

1. Make sure `.env` is filled in. `compose.yml` reads it directly.

2. Register slash commands once:

```bash
docker build --target build -t lituus-discord-bot-command-runner .
docker run --rm --env-file .env lituus-discord-bot-command-runner npm run commands:register
```

The command registration script uses `tsx` and source files from `src/`, so it runs from the Docker `build` stage instead of the final production image.

3. Start the bot:

```bash
docker compose up -d --build
```

4. Follow logs:

```bash
docker compose logs -f
```

5. Stop it:

```bash
docker compose down
```

The compose file mounts `./data` and `./recordings` into the bot container, so SQLite data and audio files stay on the host.

Docker usually creates these host folders automatically when the bind mounts are first used, but you can create them explicitly with:

```bash
mkdir -p data recordings
```

If Docker prints a BuildKit/buildx warning, install or enable the Docker Buildx plugin. The bot can still build with the legacy builder for now, but Buildx is the supported path going forward.

## Notes

- Recording controls are limited to `ALLOWED_DISCORD_USER_IDS`.
- Recordings auto-stop when the active Stage is ended, after `RECORDING_MAX_DURATION_MS`, or after `RECORDING_IDLE_STOP_MS` with no active speakers. Set either duration value to `0` to disable that guard.
- Recording start, manual stop, and auto-stop completion messages post in the Stage chat.
