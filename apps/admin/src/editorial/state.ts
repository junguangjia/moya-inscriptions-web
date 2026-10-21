import type { PayloadRequest } from "payload";

interface MutationState {
  mode: "create" | "draft" | "publish" | "withdraw" | "restore";
  expectedRevision?: number;
  nextRevision?: number;
}

// Payload clones req with Object.create(req) when restoring a version.
// These maps never depend on caller-supplied req.context flags or JSON fields.
const mutations = new WeakMap<object, MutationState>();
const approvedPublishRequests = new WeakSet<object>();
const ledgerRequests = new WeakSet<object>();
const identityRequests = new WeakSet<object>();
const identityAccessToken = Symbol("editorialIdentityAccess");

const ancestors = (request: object): object[] => {
  const result: object[] = [];
  let current: object | null = request;
  for (let index = 0; current && index < 4; index += 1) {
    result.push(current);
    current = Object.getPrototypeOf(current) as object | null;
  }
  return result;
};

export const mutationState = (
  req: PayloadRequest,
): MutationState | undefined => {
  for (const ancestor of ancestors(req)) {
    const state = mutations.get(ancestor);
    if (state) return state;
  }
  return undefined;
};

export const setMutationState = (req: PayloadRequest, state: MutationState) =>
  mutations.set(req, state);

export const clearMutationState = (req: PayloadRequest) =>
  mutations.delete(req);

export const isApprovedPublishRequest = (req: PayloadRequest): boolean =>
  ancestors(req).some((ancestor) => approvedPublishRequests.has(ancestor));

export const isLedgerRequest = (req: PayloadRequest): boolean =>
  ancestors(req).some((ancestor) => ledgerRequests.has(ancestor));

export const withApprovedPublish = async <T>(
  req: PayloadRequest,
  work: () => Promise<T>,
): Promise<T> => {
  approvedPublishRequests.add(req);
  try {
    return await work();
  } finally {
    approvedPublishRequests.delete(req);
  }
};

export const withLedgerWrite = async <T>(
  req: PayloadRequest,
  work: () => Promise<T>,
): Promise<T> => {
  ledgerRequests.add(req);
  try {
    return await work();
  } finally {
    ledgerRequests.delete(req);
  }
};

/** Payload query permissions wrap req in a Proxy; a private symbol survives
 * that proxy, while HTTP JSON/context cannot manufacture the registered token. */
export const isIdentityRequest = (req: PayloadRequest): boolean => {
  const token: unknown = Reflect.get(req, identityAccessToken);
  return (
    token !== null && typeof token === "object" && identityRequests.has(token)
  );
};

export const withIdentityAccess = async <T>(
  req: PayloadRequest,
  work: () => Promise<T>,
): Promise<T> => {
  const previous = Object.getOwnPropertyDescriptor(req, identityAccessToken);
  const token = {};
  identityRequests.add(token);
  Object.defineProperty(req, identityAccessToken, {
    value: token,
    configurable: true,
  });
  try {
    return await work();
  } finally {
    identityRequests.delete(token);
    if (previous) Object.defineProperty(req, identityAccessToken, previous);
    else Reflect.deleteProperty(req, identityAccessToken);
  }
};

const deliveryRequests = new WeakMap<
  object,
  { intentId: string; fingerprint: string }
>();
export const catalogDeliveryPublishProof = (req: PayloadRequest) => {
  for (const ancestor of ancestors(req)) {
    const proof = deliveryRequests.get(ancestor);
    if (proof) return proof;
  }
  return undefined;
};
export const withCatalogDeliveryPublish = async <T>(
  req: PayloadRequest,
  proof: { intentId: string; fingerprint: string },
  work: () => Promise<T>,
): Promise<T> => {
  deliveryRequests.set(req, proof);
  try {
    return await work();
  } finally {
    deliveryRequests.delete(req);
  }
};
