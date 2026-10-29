# Dear Me, From Your Agent

Each resident sends their Agent Village agent, the one that knew them for three weeks, one prompt. The agent writes them a letter for next year and replies with a link.
One tap locks the letter on the resident's own phone with drand timelock encryption until **31 Oct 2027, 20:00 IST**, and nobody can open it early: not the resident, not us.

> FutureMe is you writing to yourself. This is the agent that knew you for three weeks, writing to you, sealed by math.

Built for the Edge India Buildathon at Edge City India (Mandrem, Goa), Code track, aiming for the Agent Village prize.

## How it uses Agent Village

We install nothing into anyone's agent and read none of their data. Letters are written by residents' own Agent Village agents, and the residents seal them.

### One prompt, one tap: the seal link

1. The resident copies the prompt from `/ask` (the bot's `/start` gives the same prompt) and sends it to their agent in their private chat.
2. The prompt asks the agent to write the letter, put it in a Python variable called `letter`, and run two lines of Python. They print a seal link, and the agent replies with only that:

   ```python
   import base64, zlib
   print("https://<host>/seal#" + base64.b64encode(zlib.compress(letter.encode(), 9)).decode())
   ```

3. The resident taps the link. `/seal` reads the letter from the part after `#`, which browsers never send to any server. It shows the consent text, then **Seal it unread** or **Read it first**.
4. The page seals the letter in the browser with tlock-js and sends our server only the locked capsule. It then shows the capsule link, a calendar reminder `.ics` and the `.age` file.

Why a link, and not a mini-app or a bot that talks to the agent:

- **Telegram bots can't read messages from other bots,** so our bot can't take a letter from the agent directly.
- **Agent Village mini-apps can't store data yet.** Partner mini-apps may only read public data. Apps that write are planned (v3), not built, and every app needs Edge City's review and a fleet-wide update first.
- **The link needs no new permissions.** Agent Village's own rules let an agent run Python for "parsing, converting or calculating". The Python here only encodes text and prints it, with no network access, nothing installed and no files.
- **zlib keeps the link short and checks it.** A 270-word letter makes a 1,125-character link, against 2,025 with plain base64, so the agent has less to copy. If the agent copies it wrong, the page says the link is damaged rather than sealing gibberish.
- **Standard base64, not base64url,** because an underscore can turn into italics on its way through Markdown to Telegram.

### Or forward the letter to the bot

If an agent can't run code, the prompt asks it to reply with the letter itself, and the resident forwards that to the bot:

1. `/start` on the bot shows the consent text and an **I agree** button.
2. The bot gives the resident the same prompt to send to their own agent in their private chat.
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
- **Sealing.** The resident's browser (for a seal link) or our server (for the bot) seals with [tlock-js](https://github.com/drand/tlock-js), using the quicknet chain info pinned in code, so sealing needs no network. Only the armored ciphertext is stored.
- **Opening.** Opening happens in the browser. The page fetches the round's beacon from drand, drand-client verifies it against the pinned public key, and tlock-js decrypts. Our server never decrypts.

## Pages

| Path | What it is |
|---|---|
| `/wall` | For the projector. Sealed envelopes, "N letters from M agents", and a live countdown. It polls `/api/wall` every 10 seconds and new envelopes drop in. Demo capsules sit in their own row. |
| `/c/:id` | One capsule. Shows the unlock date, a countdown and the round. **Try to open now** shows the real error from tlock-js and drand's `425 Too Early`. When the round arrives, the page opens itself. |
| `/open` | Paste or upload any `.age` capsule. Needs no database, and works as a saved file. |
| `/demo` | Stage mode, fully client-side. Seals a sample letter for 60 (or 30) seconds, fails to open it early, then opens it the moment drand publishes the round, with a link to the beacon. |
| `/ask` | The prompt to send your agent, with a copy button, and the bot as the fallback. The wall points here. |
| `/seal#…` | Seals the letter in a seal link, in the browser. Remembers on the device which letters it sealed, so a second tap shows the capsule instead of sealing it twice, and a bare `/seal` lists them. |
| `/api/wall` | `{ realCount, uniqueAgents, demoCount, unlockAt, capsules: [{ id, kind, sealedAt, unlockAt }] }`. Never any text. |
| `/api/config` | `{ unlockAt, round, maxChars, bot }` for `/seal` and `/ask`. |
| `POST /api/capsules` | `{ ciphertext }` from `/seal`, answered `201 { id, url, round, unlockAt }`. Only accepts a tlock capsule for quicknet and our unlock round, at most 20,000 characters, and nothing after the unlock time. At most 200 new capsules per address and 600 in total each hour. The same capsule sent again (a retry after a lost answer) gets `200` and the capsule already stored, never a second copy. |
| `DELETE /api/c/:id` | Deletes our copy of a capsule sealed from a seal link: holding its link is owning it. A bot capsule can't be deleted here, only with `/burn` by its owner. |

## What is real and what is demo

- **Real.** Capsules sealed from a seal link (`kind = resident`, `source = link`) or through the bot, by residents (`kind = resident`) or for ODIN (`kind = village`).
- **Demo.** Capsules made by the admin-only `/demo_seed` (`kind = demo`). They say "Demo" everywhere, sit in their own row on the wall, and are never counted in "N letters from M agents".
- **`/demo` page.** Seals the sample letter in the browser and stores nothing.

Counts at submission: _fill in on Friday from the deployed `/api/wall`: N real letters from M agents, D demo capsules._

```bash
curl -s https://<host>/api/wall | jq '{realCount, uniqueAgents, demoCount}'
```

## Privacy

- **Seal links.** The letter never reaches our server.
  - It travels in the part of the link after `#`, which browsers never send.
  - `/seal` seals it in the browser and posts only the armored ciphertext. No endpoint accepts a letter.
  - After sealing, the address bar shows the capsule link instead of the letter.
  - The agent's message with the link still holds the letter in readable form. The page tells the resident so, and suggests deleting that message once the capsule link is saved.
  - The page accepts only zlib-compressed links. A link damaged on the way fails zlib's checksum and is refused, never sealed as different text.
- **Plaintext in the bot.** A forwarded letter exists only in memory, from the moment it is forwarded until Seal, Cancel, or 30 minutes without an answer. It is never written to the database, files or logs. Logs carry event names, message ids and counts only.
  - `test/bot.test.ts` runs a full session and checks that no 20-character piece of the letter appears in the SQLite files (including `-wal` and `-shm`) or in anything printed.
- **Preview.** At most the first ~80 characters.
- **What we store.**
  - Per capsule: the armored ciphertext, its round, timestamps, kind, source label, a salted hash of the owner's Telegram id and, for agent-written letters, a salted hash of the agent's bot username (only to count unique agents).
  - A capsule sealed from a seal link has no Telegram owner: its owner hash is derived from its own id, and it has no agent hash.
  - Per resident: a consent record with a salted hash and a timestamp.
  - The rate limit holds client addresses in memory for an hour. They are never logged or stored.
  - On the resident's device, `/seal` keeps a SHA-256 hash of each letter it sealed, with its capsule link and the time, in the browser's local storage.
- **The wall.**
  - Shows that a letter exists, never its text or anyone's name or handle.
  - The `id`s in `/api/wall` are one-way hashes, not capsule ids: a capsule link opens the letter after the unlock date, so the wall must never hand links out.
  - All pages send `Referrer-Policy: no-referrer`.
- **Deleting our copy.** It clears the ciphertext, with SQLite `secure_delete` on and the WAL checkpointed. The owner's `.age` file still opens the letter.
  - A bot capsule is deleted with `/burn <id>`.
  - A capsule sealed from a seal link is deleted from its own page, with **Delete our copy**, or with `/burn <link>` in the bot. It has no Telegram owner, so whoever holds its link can delete it.
- **Consent text** (shown at `/start`):
  - Your agent's letter is locked until 31 Oct 2027, 20:00 IST. Nobody can open it before then: not you, not us.
  - After that date, anyone holding your capsule file or link can open it. Keep them private.
  - The public wall only shows that a letter exists. Never its text, never your name.
  - You can delete our copy at any time with /burn.
- **Consent text on `/seal`**, above the Seal button: the same points, except that the letter is sealed on the resident's own device, our server only receives the locked capsule, and our copy is deleted from the capsule's page.

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
- Set `NODE_ENV=production` (the Dockerfile already does). If another process starts polling with the same bot token, the deployed bot takes polling back within seconds, and any other run gives it up.

For local experiments with the bot, use a second bot from BotFather, so a laptop never takes messages meant for the deployed bot.

## Notes

- **The unlock round rounds up.** If `UNLOCK_AT` falls between rounds, the letter locks to the next round, so it can never open before the stated time. The default is exactly round 44063212.
- **"M agents" counts (resident, agent bot) pairs, plus one per seal-link letter.** Each resident's personal agent then counts once, even if every agent in the village shares one bot account. A seal link carries no agent identity, so each letter sealed from one counts as one agent: only an agent running code makes the link. A resident who seals two link letters counts twice.
- **Daily limit.** Residents may seal 3 letters in any 24 hours through the bot. Demo and burned capsules don't count, and admins are exempt. Letters are capped at 4,000 characters, on the bot and on `/seal`.
- **Seal links and Telegram.** A 300-word letter makes a link of about 1,100 to 1,500 characters, well under Telegram's 4,096-character message limit. We have tested the link with the prompt's own Python and in Chromium, but not yet in Telegram's in-app browser or with a live Agent Village agent.
- **After the unlock time** the bot and `/seal` stop sealing, because a letter sealed to an already-published round would open at once.
- **`UNLOCK_AT` must include its timezone offset**, or the server would read it in its own timezone.

## Built here versus reused

- **Built during the buildathon:** everything in this repository.
  - the seal link and the `/seal` and `/ask` pages,
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
