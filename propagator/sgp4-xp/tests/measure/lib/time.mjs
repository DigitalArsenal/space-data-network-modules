// Time stamps as the experiment's bookkeeping needs them: milliseconds since the Unix epoch and back. The modules
// are given and return ISO strings; this only places window boundaries.
export const ms = (iso) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
export const iso = (t) => new Date(Math.round(t)).toISOString();
export const DAY = 86400000;
