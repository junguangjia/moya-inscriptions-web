import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadProductionProductStatesMock,
  readFormalRequestContextMock,
  readVisitorAccessMock,
  productApplicationMock,
} = vi.hoisted(() => ({
  loadProductionProductStatesMock: vi.fn(),
  readFormalRequestContextMock: vi.fn(),
  readVisitorAccessMock: vi.fn(),
  productApplicationMock: vi.fn(),
}));

vi.mock("./product-access", () => ({
  readVisitorAccess: readVisitorAccessMock,
}));

vi.mock(
  "../features/product-application/load-production-product-states",
  () => ({ loadProductionProductStates: loadProductionProductStatesMock }),
);
vi.mock("./formal-request-context", () => ({
  readFormalRequestContext: readFormalRequestContextMock,
}));
vi.mock("../features/product-application/product-application", () => ({
  ProductApplication: (props: unknown) => {
    productApplicationMock(props);
    return <div data-formal-product-application="" />;
  },
}));

import FormalPage from "./page";
import {
  CatalogSearch,
  CatalogSearchNavigationAction,
} from "../features/search/catalog-search";

const states = { identity: "production-states" };

beforeEach(() => {
  loadProductionProductStatesMock.mockReset();
  readFormalRequestContextMock.mockReset();
  productApplicationMock.mockReset();
  readVisitorAccessMock.mockReset();
  // Public mode: the Backend grants every visitor, with or without a session.
  readVisitorAccessMock.mockResolvedValue({
    state: "granted",
    closedBeta: false,
    token: undefined,
  });
  loadProductionProductStatesMock.mockResolvedValue(states);
  readFormalRequestContextMock.mockResolvedValue({
    initialPlatform: "tablet",
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("FormalPage", () => {
  it("renders the accepted Product application with Production state only", async () => {
    const markup = renderToStaticMarkup(await FormalPage({}));

    expect(markup).toContain("data-formal-product-application");
    expect(productApplicationMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "quickActions",
    );
    expect(readFormalRequestContextMock).toHaveBeenCalledOnce();
    expect(loadProductionProductStatesMock).toHaveBeenCalledOnce();
    expect(loadProductionProductStatesMock).toHaveBeenCalledWith(undefined);
    expect(markup).not.toContain("data-product-access");
    // Outside the Development runtime no comment section is composed.
    expect(productApplicationMock.mock.calls[0]?.[0]).toEqual({
      comments: null,
      authorCommunity: false,
      initialHomeFeed: "discover",
      initialPlatform: "tablet",
      initialTopicId: null,
      navigationAction: expect.objectContaining({
        type: CatalogSearchNavigationAction,
      }),
      productUtility: expect.objectContaining({ type: CatalogSearch }),
      states,
    });
    expect(productApplicationMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "inscriptionUtility",
    );
  });

  it("composes real business features in Production while retaining Development-only fixtures", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_MOYA_DISCUSSION_PREVIEW", "true");
    renderToStaticMarkup(await FormalPage({}));
    expect(productApplicationMock.mock.calls[0]?.[0]).toMatchObject({
      comments: { signInHref: "/login" },
      authorCommunity: true,
      developmentDiscussion: true,
      liveNotifications: true,
    });

    productApplicationMock.mockReset();
    vi.stubEnv("NODE_ENV", "production");
    renderToStaticMarkup(await FormalPage({}));
    expect(productApplicationMock.mock.calls[0]?.[0]).toMatchObject({
      comments: { signInHref: "/login" },
      authorCommunity: true,
      liveNotifications: true,
      articleAuthoring: true,
    });
    expect(productApplicationMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "developmentDiscussion",
    );
  });

  it.each(["discover", "nearby", "inscriptions", "calligraphy"] as const)(
    "accepts the Home %s feed query",
    async (feed) => {
      renderToStaticMarkup(
        await FormalPage({ searchParams: Promise.resolve({ feed }) }),
      );

      expect(productApplicationMock.mock.calls[0]?.[0]).toMatchObject({
        initialHomeFeed: feed,
        initialTopicId: null,
      });
    },
  );

  it.each(["topics", ["topics"]])(
    "falls back retired or invalid feed input %j to Discover",
    async (feed) => {
      renderToStaticMarkup(
        await FormalPage({
          searchParams: Promise.resolve({ feed }),
        }),
      );

      expect(productApplicationMock.mock.calls[0]?.[0]).toMatchObject({
        initialHomeFeed: "discover",
        initialTopicId: null,
      });
    },
  );

  it("hands a bounded topic to Discussion without changing the remembered Home feed", async () => {
    renderToStaticMarkup(
      await FormalPage({
        searchParams: Promise.resolve({ feed: "nearby", topic: "topic-one" }),
      }),
    );

    expect(productApplicationMock.mock.calls[0]?.[0]).toMatchObject({
      initialHomeFeed: "nearby",
      initialTopicId: "topic-one",
    });
  });

  it("ignores invalid topic and page-unowned Product History inputs", async () => {
    renderToStaticMarkup(
      await FormalPage({
        searchParams: Promise.resolve({
          catalogId: "catalog-one",
          feed: "nearby",
          image: "media-one",
          topic: "x".repeat(161),
        }),
      }),
    );

    expect(productApplicationMock.mock.calls[0]?.[0]).toEqual({
      comments: null,
      authorCommunity: false,
      initialHomeFeed: "nearby",
      initialPlatform: "tablet",
      initialTopicId: null,
      navigationAction: expect.objectContaining({
        type: CatalogSearchNavigationAction,
      }),
      productUtility: expect.objectContaining({ type: CatalogSearch }),
      states,
    });
  });

  it.each([
    [{ state: "sign_in_required" }, "内测进行中", "登录"],
    [
      {
        state: "restricted",
        account: { displayName: "访碑者", handle: "member-04" },
      },
      "暂未获得内测资格",
      "退出登录",
    ],
    [{ state: "unavailable" }, "暂时无法访问", "重试"],
  ] as const)(
    "renders only the notice for $0.state and loads no product data",
    async (access, title, action) => {
      readVisitorAccessMock.mockResolvedValue(access);

      const markup = renderToStaticMarkup(
        await FormalPage({
          searchParams: Promise.resolve({ catalogId: "catalog-one" }),
        }),
      );

      expect(markup).toContain(`data-product-access="${access.state}"`);
      expect(markup).toContain(title);
      expect(markup).toContain(action);
      expect(markup).toContain('content="noindex"');
      expect(markup).not.toContain("data-formal-product-application");
      expect(loadProductionProductStatesMock).not.toHaveBeenCalled();
      expect(readFormalRequestContextMock).not.toHaveBeenCalled();
      expect(productApplicationMock).not.toHaveBeenCalled();
    },
  );

  it("names the refused account to its owner and nothing else", async () => {
    readVisitorAccessMock.mockResolvedValue({
      state: "restricted",
      account: { displayName: "访碑者", handle: "member-04" },
    });
    const named = renderToStaticMarkup(await FormalPage({}));
    expect(named).toContain("访碑者");
    expect(named).toContain("member-04");

    readVisitorAccessMock.mockResolvedValue({
      state: "restricted",
      account: null,
    });
    expect(renderToStaticMarkup(await FormalPage({}))).not.toContain(
      "当前账号：",
    );
  });

  it("offers sign-in through the existing login page with a return destination", async () => {
    readVisitorAccessMock.mockResolvedValue({ state: "sign_in_required" });
    const markup = renderToStaticMarkup(await FormalPage({}));
    expect(markup).toContain('action="/login"');
    expect(markup).toContain('name="return"');
  });

  it("loads the product with the approved visitor's session in a closed beta", async () => {
    // A synthetic stand-in with the opaque session shape; not a credential.
    const visitorSession = "s".repeat(43);
    readVisitorAccessMock.mockResolvedValue({
      state: "granted",
      closedBeta: true,
      token: visitorSession,
    });

    const markup = renderToStaticMarkup(await FormalPage({}));

    expect(markup).toContain("data-formal-product-application");
    expect(loadProductionProductStatesMock).toHaveBeenCalledWith(
      visitorSession,
    );
  });
});
