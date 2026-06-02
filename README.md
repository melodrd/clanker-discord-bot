# lituus-discord-bot

Discord Stage recorder bot.

It joins a Stage channel, records each speaker into `.ogg` segments, transcribes completed segments with Deepgram, stores session metadata in SQLite, and can optionally generate an AI meeting summary with OpenRouter.

Discord invite permission string: `1133568`.

## Requirements

- Node.js `22.x`
- Discord bot token
- Discord application/client ID
- Discord guild ID
- Deepgram API key
- OpenRouter API key, if you want AI meeting summaries

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Fill in `.env`:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DEEPGRAM_API=
ALLOWED_DISCORD_USER_IDS=
DATABASE_PATH=
OPENROUTER_API_KEY=
```

## Environment

Required environment variables:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `DEEPGRAM_API`
- `ALLOWED_DISCORD_USER_IDS`

Optional environment variables:

- `DATABASE_PATH` - defaults to `./data/lituus.sqlite`
- `OPENROUTER_API_KEY` - leave blank to disable meeting summaries
- `OPENROUTER_MODEL` - defaults to `openai/gpt-oss-120b:free`
- `OPENROUTER_TIMEOUT_MS` - defaults to `360000`
- `OPENROUTER_MAX_TOKENS` - defaults to `140000`
- `OPENROUTER_TEMPERATURE` - defaults to `0.2`
- `RECORDING_MAX_DURATION_MS` - defaults to `14400000`
- `RECORDING_IDLE_STOP_MS` - defaults to `900000`

`ALLOWED_DISCORD_USER_IDS` is a comma-separated allowlist. If it is empty, no one can use the `/record` commands.

## Run

Register slash commands once:

```bash
npm run commands:register
```

Start in dev mode:

```bash
npm run dev
```

Build and run production:

```bash
npm run build
npm start
```

## Slash Commands

- `/ping`
- `/record start`
- `/record stop`
- `/record status`

## Data

- SQLite database: `./data/lituus.sqlite` by default
- Audio segments: `./recordings`

Keep these folders private. They contain sensitive recordings and transcripts.

Completed recordings post in the Stage chat with a raw transcript Markdown attachment. If OpenRouter is configured and summary generation succeeds, the completion message also includes an AI-generated meeting summary Markdown attachment. If OpenRouter is not configured, or summary generation fails, the raw transcript is still sent.

## Docker

Use Docker if you want a containerized runtime with persisted local data.

1. Make sure `.env` is filled in. `compose.yml` reads it directly.

2. Register slash commands once:

```bash
docker build --target build -t lituus-discord-bot-command-runner .
docker run --rm --env-file .env lituus-discord-bot-command-runner npm run commands:register
```

The command registration script uses `tsx` and source files from `src/`, so it runs from the Docker `build` stage instead of the final runtime image.

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

Docker usually creates those host folders automatically when the bind mounts are first used, but you can create them explicitly with:

```bash
mkdir -p data recordings
```

If Docker prints a BuildKit/buildx warning, install or enable the Docker Buildx plugin. The bot can still build with the legacy builder for now, but Buildx is the supported path going forward.

## Notes

- Recording controls are limited to `ALLOWED_DISCORD_USER_IDS`.
- Recordings auto-stop when the active Stage ends, after `RECORDING_MAX_DURATION_MS`, or after `RECORDING_IDLE_STOP_MS` with no active speakers. Set either duration value to `0` to disable that guard.
- Recording start, manual stop, and auto-stop completion messages post in the Stage chat.
