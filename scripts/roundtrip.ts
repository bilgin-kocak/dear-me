// First task: seal "hello" for ~9 seconds, show the early-open error, wait, open it.
// Run: node scripts/roundtrip.ts
import {
  timelockEncrypt, timelockDecrypt, mainnetClient,
  roundAt, roundTime, defaultChainInfo, Buffer,
} from "tlock-js";

const client = mainnetClient();
const round = roundAt(Date.now() + 9_000, defaultChainInfo);
const opensAt = roundTime(defaultChainInfo, round);
console.log(`sealing "hello" to drand quicknet round ${round} (${new Date(opensAt).toISOString()})`);

const armored = await timelockEncrypt(round, Buffer.from("hello", "utf8"), client);
console.log(armored);

try {
  await timelockDecrypt(armored, client);
  throw new Error("opened early: this should be impossible");
} catch (err) {
  console.log(`early open failed as expected: ${(err as Error).message}`);
}

await new Promise((r) => setTimeout(r, Math.max(0, opensAt - Date.now())));
for (let attempt = 1; ; attempt++) {
  try {
    const plain = await timelockDecrypt(armored, client);
    console.log(`opened after ${attempt} attempt(s): "${plain.toString("utf8")}"`);
    console.log(`proof: https://api.drand.sh/${defaultChainInfo.hash}/public/${round}`);
    break;
  } catch (err) {
    if (attempt >= 20) throw err;
    console.log(`beacon not available yet (${(err as Error).message}), retrying in 1s`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
