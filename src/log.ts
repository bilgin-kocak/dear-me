// Logs carry event names, message ids and counts. Never letter text, names,
// handles or capsule ids (a capsule id is the key to its link).

export type Log = (event: string, fields?: Record<string, string | number | boolean>) => void;

export const stdoutLog: Log = (event, fields = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
