/**
 * The exact-first order of a user lookup, as `CASE` arms over a SQL expression:
 * id, then handle, then display name, then anything that merely contains the text.
 * `u` is `community.public_users`.
 */
export const userMatchRankArms = (text: string): string =>
  `WHEN ${text} <> '' AND u.id = ${text} THEN 0
   WHEN ${text} <> '' AND lower(u.handle) = lower(ltrim(${text},'@')) THEN 1
   WHEN ${text} <> '' AND lower(u.display_name) = lower(${text}) THEN 2
   ELSE 3`;
