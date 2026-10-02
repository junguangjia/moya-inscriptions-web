import type {
  AuthorListQuery,
  AuthorMedia,
  AuthorProfile,
  AvatarUpdate,
  BackgroundUpdate,
  ContentIdentity,
  ContentRelationUpdate,
  GuestFavoriteMerge,
  PrivacyUpdate,
  ProfileUpdate,
  RelationshipUpdate,
  UserWork,
} from "@moya/contracts";

export interface AuthorPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}
export interface AuthorListItem {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly studioName?: string;
  readonly avatar: AuthorMedia | null;
}
export interface OwnedMediaInput {
  readonly requestId?: string;
  readonly id: string;
  readonly ownerId: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}
export interface OwnedMediaRead {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}
/** Backend-owned community data. All writes and their audit/receipt are atomic. */
export interface AuthorCommunityPort {
  readProfile(id: string, viewerId: string | null): Promise<AuthorProfile>;
  updateProfile(actorId: string, input: ProfileUpdate): Promise<void>;
  updateBackground(actorId: string, input: BackgroundUpdate): Promise<void>;
  updatePrivacy(actorId: string, input: PrivacyUpdate): Promise<void>;
  updateAvatar(
    actorId: string,
    input: AvatarUpdate,
  ): Promise<{ nextChangeAt: string }>;
  saveMedia(input: OwnedMediaInput): Promise<AuthorMedia>;
  readMedia(
    id: string,
    viewerId: string | null,
  ): Promise<OwnedMediaRead | null>;
  follow(actorId: string, input: RelationshipUpdate): Promise<void>;
  block(actorId: string, input: RelationshipUpdate): Promise<void>;
  listPeople(
    id: string,
    viewerId: string | null,
    list: "following" | "followers" | "blocks",
    query: AuthorListQuery,
  ): Promise<AuthorPage<AuthorListItem>>;
  readWork(id: string, viewerId: string | null): Promise<UserWork>;
  listWorks(
    id: string,
    viewerId: string | null,
    query: AuthorListQuery,
  ): Promise<AuthorPage<UserWork>>;
  changeRelation(
    actorId: string,
    relation: "favorite" | "like",
    input: ContentRelationUpdate,
  ): Promise<void>;
  mergeGuestFavorites(
    actorId: string,
    input: GuestFavoriteMerge,
  ): Promise<{ acknowledged: readonly ContentIdentity[] }>;
}
