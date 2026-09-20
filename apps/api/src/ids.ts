import * as v from "valibot";

// Keep existing UUID references readable while all newly generated IDs use ULIDs.
export const idSchema = v.union([
  v.pipe(v.string(), v.regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)),
  v.pipe(v.string(), v.uuid()),
]);
