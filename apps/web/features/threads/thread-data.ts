// Plain re-export boundary so "use client" files never import lib/public-api.
export {
  authorClient,
  AuthorRequestError,
} from "../../lib/public-api/author-community-client";
