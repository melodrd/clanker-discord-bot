# clanker-discord-bot

Discord Stage recorder bot.

It joins a Stage channel, records each speaker into `.ogg` segments, transcribes completed segments with Deepgram, stores session metadata in SQLite, and can optionally generate an AI meeting summary with OpenRouter.

Discord invite permission string: `1133568`.

## Invite The Bot

Before doing anything else, add the bot to your Discord server.

1. Open the Discord OAuth2 URL generator for your application.
2. Select the `bot` and `applications.commands` scopes.
3. Use permission integer `1133568`.
4. Invite the bot to the target server.

If you prefer to build the invite URL manually, use:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1133568&scope=bot%20applications.commands
```

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
DATABASE_PATH=./data/clanker.sqlite
RECORDINGS_DIR=./recordings
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

- `DATABASE_PATH` - defaults to `./data/clanker.sqlite`
- `RECORDINGS_DIR` - defaults to `./recordings`
- `OPENROUTER_API_KEY` - leave blank to disable meeting summaries
- `OPENROUTER_MODEL` - comma-separated model retry order; defaults to `openrouter/free, tencent/hy3:free, openai/gpt-oss-20b:free, poolside/laguna-m.1:free`
- `OPENROUTER_TIMEOUT_MS` - defaults to `300000`
- `OPENROUTER_MAX_TOKENS` - defaults to `8000`
- `OPENROUTER_TEMPERATURE` - defaults to `0.2`
- `RECORDING_MAX_DURATION_MS` - defaults to `14400000`
- `RECORDING_IDLE_STOP_MS` - defaults to `900000`

`ALLOWED_DISCORD_USER_IDS` is a comma-separated allowlist. If it is empty, no one can use the `/record` commands.

Meeting summaries use OpenRouter, trying each model in `OPENROUTER_MODEL` in order until one succeeds.

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

To use recording, join an active Stage and run `/record start` in the Stage chat. Use `/record stop` to end it manually. It also stops automatically when the Stage ends.

## Data

- SQLite database: `./data/clanker.sqlite` by default
- Audio segments: `./recordings` by default

Keep these folders private. They contain sensitive recordings and transcripts.

Completed recordings post in the Stage chat with a raw transcript Markdown attachment. If OpenRouter is configured and summary generation succeeds, the completion message also includes an AI-generated meeting summary Markdown attachment. If OpenRouter is not configured, or summary generation fails, the raw transcript is still sent.

## Docker

Use Docker if you want a containerized runtime with persisted local data. Make sure the bot has already been invited to your Discord server, then run the commands below.

1. Make sure `.env` is filled in. `compose.yml` reads it directly.

2. Register slash commands once:

```bash
docker build --target build -t clanker-discord-bot-command-runner .
docker run --rm --env-file .env clanker-discord-bot-command-runner npm run commands:register
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

## Railway

Railway can run the existing Dockerfile as an always-on worker. The bot does not serve HTTP, so it does not need a public domain, an exposed port, or an HTTP health server.

1. Create a Railway project from the `melodrd/clanker-discord-bot` GitHub repository. While testing this deployment, configure the service to use the `deploy/railway` branch.
2. Let Railway auto-detect and build the existing `Dockerfile`. Configure the service as an always-running worker and do not generate a public domain.
3. Add one persistent volume and mount it at exactly `/app/storage`.
4. Configure these required service variables:

```env
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CLIENT_ID=your-discord-application-id
DISCORD_GUILD_ID=your-discord-server-id
DEEPGRAM_API=your-deepgram-api-key
ALLOWED_DISCORD_USER_IDS=comma-separated-discord-user-ids
DATABASE_PATH=/app/storage/clanker.sqlite
RECORDINGS_DIR=/app/storage/recordings
```

To enable optional meeting summaries, also configure `OPENROUTER_API_KEY`. You may override `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_MAX_TOKENS`, and `OPENROUTER_TEMPERATURE` if needed.

After the service variables are available, register slash commands once from Railway's service shell or as a one-off command:

```bash
npm run commands:register
```

The command uses the compiled registrar in the production image, so it can run in the deployed service shell or as a Railway one-off command. This is a one-time deployment task; do not change the worker start command, which remains `node dist/index.js`.

### Migrating data from Azure

Stop the Azure bot before taking the final backup so SQLite and recording files cannot change during the copy. Create a consistent SQLite backup with SQLite's `.backup` command (preferred), and copy the recordings directory into a separate migration bundle. Transfer that bundle to a temporary directory in the Railway service using a private, authenticated method; do not publish it at a public URL.

Before installing anything, stop the Railway worker and inspect `/app/storage`. Only install the Azure database when `/app/storage/clanker.sqlite` does not already exist. If Railway has already created a newer database, keep it and perform a deliberate SQLite-level merge or restore into a separate project instead of replacing it. For recordings, copy without overwriting files that are already present:

```bash
if [ -e /app/storage/clanker.sqlite ]; then
  echo "Database already exists; leaving it unchanged."
else
  install -m 600 /tmp/azure-migration/clanker.sqlite /app/storage/clanker.sqlite
fi
mkdir -p /app/storage/recordings
cp -an /tmp/azure-migration/recordings/. /app/storage/recordings/
```

Verify ownership, file counts, and the bot's startup logs before deleting the temporary migration bundle or decommissioning Azure. Restart the Railway worker only after the copy is complete. Recordings and transcripts are sensitive data: keep the Railway volume private and restrict project and shell access.

## Notes

- Recording controls are limited to `ALLOWED_DISCORD_USER_IDS`.
- Recordings also auto-stop after `RECORDING_MAX_DURATION_MS` or after `RECORDING_IDLE_STOP_MS` with no active speakers. Set either duration value to `0` to disable that guard.
- Recording start, manual stop, and auto-stop completion messages post in the Stage chat.
