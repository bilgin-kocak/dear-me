# Dear Me, From Your Agent

Each resident asks their Agent Village agent, the one that knew them for three weeks, to write them a letter for next year, then forwards it to our Telegram bot.
The bot locks it with drand timelock encryption until **31 Oct 2027, 20:00 IST**, and nobody can open it early: not the resident, not us.

> FutureMe is you writing to yourself. This is the agent that knew you for three weeks, writing to you, sealed by math.

Built for the Edge India Buildathon at Edge City India (Mandrem, Goa), Code track, aiming for the Agent Village prize.

## How it uses Agent Village

We install nothing into anyone's agent and read none of their data. Letters are written by residents' own Agent Village agents and forwarded by the residents.

1. `/start` on the bot shows the consent text and an **I agree** button.
2. The bot gives the resident a prompt to send to their own agent in their private chat.
3. The resident forwards the agent's reply to the bot. Agents often split long replies, so the bot gathers everything that chat sends in the 90 seconds after the first message and merges it in order.
4. Telegram's `forward_origin` labels the letter:
   - forwarded from a bot: **Written by an agent**
   - forwarded from a hidden or other account: **Unverified**
   - typed by the resident: **Written by the resident**
5. The resident sees an 80-character preview and taps **Seal until 31 Oct 2027**.
6. The bot deletes the forwarded messages and the preview from its chat (the original stays in the agent's chat) and sends:
   - the capsule link,
   - the capsule file `dear-me-<id>.age`,
   - a calendar reminder `.ics`.

ODIN, the village's god agent, can write the whole village a letter: an admin sends `/village` and forwards ODIN's answer, and it appears on the wall as a large gold envelope.

## How the lock works

- **drand quicknet** is a public randomness beacon run by the [League of Entropy](https://www.drand.love/loe), a group of independent organisations. Every 3 seconds the network publishes a numbered round, signed with a threshold BLS signature.
  - chain hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`
  - genesis 1692803367
- **tlock** encrypts to a future round number with identity-based encryption. The key that decrypts it is that round's signature, which no single party can produce early: it exists only once the network publishes the round. Here is a real published beacon from our first test: <https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/33461981>.
- 31 Oct 2027, 20:00 IST is round **44063212**, published at `2027-10-31T14:30:00Z`. Until then, `https://api.drand.sh/<chain>/public/44063212` answers `425 Too Early`.
- **Sealing.** The server seals with [tlock-js](https://github.com/drand/tlock-js) using the quicknet chain info pinned in code, so sealing needs no network. Only the armored ciphertext is stored.
- **Opening.** Opening happens in the browser. The page fetches the round's beacon from drand, drand-client verifies it against the pinned public key, and tlock-js decrypts. Our server never decrypts.

## Pages

| Path | What it is |
|---|---|
| `/wall` | For the projector. Sealed envelopes, "N letters from M agents", and a live countdown. It polls `/api/wall` every 10 seconds and new envelopes drop in. Demo capsules sit in their own row. |
| `/c/:id` | One capsule. Shows the unlock date, a countdown and the round. **Try to open now** shows the real error from tlock-js and drand's `425 Too Early`. When the round arrives, the page opens itself. |
| `/open` | Paste or upload any `.age` capsule. Needs no database, and works as a saved file. |
| `/demo` | Stage mode, fully client-side. Seals a sample letter for 60 (or 30) seconds, fails to open it early, then opens it the moment drand publishes the round, with a link to the beacon. |
| `/api/wall` | `{ realCount, uniqueAgents, demoCount, unlockAt, capsules: [{ id, kind, sealedAt, unlockAt }] }`. Never any text. |

## What is real and what is demo

- **Real.** Capsules sealed through the bot, by residents (`kind = resident`) or for ODIN (`kind = village`).
- **Demo.** Capsules made by the admin-only `/demo_seed` (`kind = demo`). They say "Demo" everywhere, sit in their own row on the wall, and are never counted in "N letters from M agents".
- **`/demo` page.** Seals the sample letter in the browser and stores nothing.

Counts at submission: _fill in on Friday from the deployed `/api/wall`: N real letters from M agents, D demo capsules._

```bash
curl -s https://<host>/api/wall | jq '{realCount, uniqueAgents, demoCount}'
```

## Privacy

- **Plaintext.** A letter exists only in memory, from the moment it is forwarded until Seal, Cancel, or 30 minutes without an answer. It is never written to the database, files or logs. Logs carry event names, message ids and counts only.
  - `test/bot.test.ts` runs a full session and checks that no 20-character piece of the letter appears in the SQLite files (including `-wal` and `-shm`) or in anything printed.
- **Preview.** At most the first ~80 characters.
- **What we store.**
  - Per capsule: the armored ciphertext, its round, timestamps, kind, source label, a salted hash of the owner's Telegram id and, for agent-written letters, a salted hash of the agent's bot username (only to count unique agents).
  - Per resident: a consent record with a salted hash and a timestamp.
- **The wall.**
  - Shows that a letter exists, never its text or anyone's name or handle.
  - The `id`s in `/api/wall` are one-way hashes, not capsule ids: a capsule link opens the letter after the unlock date, so the wall must never hand links out.
  - All pages send `Referrer-Policy: no-referrer`.
- **`/burn <id>`** deletes our copy: it clears the ciphertext, with SQLite `secure_delete` on and the WAL checkpointed. The owner's `.age` file still opens the letter.
- **Consent text** (shown at `/start`):
  - Your agent's letter is locked until 31 Oct 2027, 20:00 IST. Nobody can open it before then: not you, not us.
  - After that date, anyone holding your capsule file or link can open it. Keep them private.
  - The public wall only shows that a letter exists. Never its text, never your name.
  - You can delete our copy at any time with /burn.

## Opening a capsule in 2027 without our server

You need the `.age` file the bot sent you. Either of these works:

1. **The `/open` page, saved.** Save the page now (Ctrl+S or Cmd+S). It is one self-contained HTML file with the decryption code inlined, and it talks only to the public drand network. In 2027, open it in a browser, paste or choose your `.age` file, and press Open.
2. **drand's command-line tool, [`tle`](https://github.com/drand/tlock).** Run:

   ```bash
   go install github.com/drand/tlock/cmd/tle@latest
   ```

   ```bash
   tle --decrypt --chain 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971 -o letter.txt dear-me-<id>.age
   ```

   We have not run `tle` against our capsules. Our capsules are standard tlock age files, and the test suite checks that the stock tlock-js mainnet client opens them.

## Run it

You need Node 22.18 or newer (it runs the TypeScript directly).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run build
```

```bash
npm start
```

- **Without `TELEGRAM_BOT_TOKEN`** it serves only the web pages, at <http://localhost:3000/wall> by default.
- **`HASH_SALT`** is required when the bot runs. Never change it after launch.
- **Admin commands.** `ADMIN_TG_IDS` lists the Telegram ids allowed to use `/village` and `/demo_seed`. `/demo_seed` makes three demo capsules plus one that opens in two minutes, for rehearsing a capsule page opening itself.

Tests (`test/network.test.ts` talks to drand; `SKIP_NETWORK=1` skips it; behind an HTTPS proxy, add `NODE_USE_ENV_PROXY=1`):

```bash
npm test
```

```bash
npm run typecheck
```

The first task's round-trip script seals "hello" for about 9 seconds, shows the early-open error, then opens it:

```bash
npm run roundtrip
```

## Deploy

Run **one** Node process with HTTPS and a **persistent disk** for SQLite.

- **One instance only.** The bot uses long polling, so two instances fight over updates.
- **Persistent disk.** Without one, capsule links break after a restart. The letters survive anyway, because owners hold the `.age` files.
- **No compiler needed.** The repo's `.npmrc` skips install scripts: better-sqlite3 ships prebuilt binaries, so `npm ci` takes seconds.

**Fly.io**, using the included `Dockerfile` and `fly.toml`:

- The `fly.toml` keeps one Machine always on (`auto_stop_machines = "off"`, `min_machines_running = 1`). The bot long-polls Telegram from inside the Machine, and Fly never counts that as traffic, so with Fly's default auto-stop it would sleep and residents' messages would go unanswered.
- When `fly launch` offers to copy the existing configuration, say yes.

```bash
fly launch --no-deploy
```

```bash
fly volumes create data --size 1 --region bom
```

```bash
fly secrets set TELEGRAM_BOT_TOKEN=... HASH_SALT="$(openssl rand -base64 32)" PUBLIC_BASE_URL=https://<app>.fly.dev ADMIN_TG_IDS=...
```

```bash
fly deploy
```

```bash
fly scale count 1
```

**Render** (or any VPS):

- Build command `npm ci && npm run build`.
- Start command `node src/main.ts`. Call node directly rather than `npm start`, so the shutdown signal reaches the app.
- Keep the instance always on (not a free instance that sleeps), for the same long-polling reason.
- Attach a disk at `/data` and set `DB_PATH=/data/dear-me.db` plus the variables in `.env.example`.

## Notes

- **The unlock round rounds up.** If `UNLOCK_AT` falls between rounds, the letter locks to the next round, so it can never open before the stated time. The default is exactly round 44063212.
- **"M agents" counts (resident, agent bot) pairs.** Each resident's personal agent then counts once, even if every agent in the village shares one bot account.
- **Daily limit.** Residents may seal 3 letters in any 24 hours. Demo and burned capsules don't count, and admins are exempt. Letters are capped at 4,000 characters.
- **After the unlock time** the bot stops sealing, because a letter sealed to an already-published round would open at once.
- **`UNLOCK_AT` must include its timezone offset**, or the server would read it in its own timezone.

## Built here versus reused

- **Built during the buildathon:** everything in this repository.
  - the bot flow and its texts,
  - the forward classifier and merge window,
  - the SQLite store,
  - the pages and their envelope design,
  - the stage demo,
  - the tests.
- **Reused:**
  - [tlock-js](https://github.com/drand/tlock-js) and drand-client, by drand,
  - the drand network, run by the [League of Entropy](https://www.drand.love/loe),
  - [grammY](https://grammy.dev), [Hono](https://hono.dev), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [esbuild](https://esbuild.github.io).

## Credits

Time-lock encryption by [tlock](https://github.com/drand/tlock) and [tlock-js](https://github.com/drand/tlock-js), randomness by [drand](https://drand.love) and the [League of Entropy](https://www.drand.love/loe). Letters by the residents' own Agent Village agents.
