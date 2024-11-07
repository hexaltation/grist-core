import { GenericEventFormatter } from "app/server/lib/AuditEventFormatter";
import { AuditLogger, Deps, IAuditLogger } from "app/server/lib/AuditLogger";
import axios from "axios";
import { assert } from "chai";
import nock from "nock";
import * as sinon from "sinon";
import { TestServer } from "test/gen-server/apiUtils";
import { configForUser } from "test/gen-server/testUtils";
import {
  isCreateDocumentEvent,
  isCreateSiteEvent,
} from "test/server/lib/helpers/AuditLoggerUtils";
import { EnvironmentSnapshot, setTmpLogLevel } from "test/server/testUtils";

describe("AuditLogger", function () {
  this.timeout(10000);
  setTmpLogLevel("error");

  let oldEnv: EnvironmentSnapshot;
  let server: TestServer;
  let homeUrl: string;
  let auditLogger: IAuditLogger;
  let oid: number;

  const sandbox: sinon.SinonSandbox = sinon.createSandbox();
  const chimpy = configForUser("Chimpy");
  const chimpyEmail = "chimpy@getgrist.com";

  before(async function () {
    oldEnv = new EnvironmentSnapshot();
    process.env.TYPEORM_DATABASE = ":memory:";
    process.env.GRIST_DEFAULT_EMAIL = chimpyEmail;
    sandbox.stub(Deps, "CACHE_TTL_MS").value(0);
    sandbox.stub(Deps, "MAX_CONCURRENT_REQUESTS").value(10);
    server = new TestServer(this);
    homeUrl = await server.start();
    oid = (await server.dbManager.testGetId("NASA")) as number;
  });

  beforeEach(function () {
    auditLogger = new AuditLogger(server.dbManager, {
      formatters: [new GenericEventFormatter()],
    });
  });

  after(async function () {
    sandbox.restore();
    oldEnv.restore();
    await server.stop();
  });

  describe("logEventOrThrow", function () {
    beforeEach(async function () {
      // Ignore "config.*" audit events; some tests call the `/configs`
      // endpoint as part of setup, which triggers them.
      nock("https://audit.example.com")
        .persist()
        .post(/\/events\/.*/, (body) => body.action?.startsWith("config."))
        .reply(200);
    });

    afterEach(function () {
      nock.abortPendingRequests();
      nock.cleanAll();
    });

    it("streams installation events to a single destination", async function () {
      await axios.put(
        `${homeUrl}/api/install/configs/audit_log_streaming_destinations`,
        [
          {
            id: "62c9ed25-1195-48e7-a9f6-0ba164128c20",
            name: "other",
            url: "https://audit.example.com/events/install",
            token: "Bearer a6c8c7fd-b1d7-431e-8d64-3302f7ea0d74",
          },
        ],
        chimpy
      );
      const scope = nock("https://audit.example.com")
        .post("/events/install", (body) => isCreateSiteEvent(body))
        .matchHeader(
          "Authorization",
          "Bearer a6c8c7fd-b1d7-431e-8d64-3302f7ea0d74"
        )
        .reply(200);

      await assert.isFulfilled(
        auditLogger.logEventOrThrow(null, {
          action: "site.create",
          details: {
            site: {
              id: 42,
              name: "Grist Labs",
              domain: "gristlabs",
            },
          },
        })
      );
      assert.isTrue(scope.isDone());
    });

    it("streams installation and site events to a single destination", async function () {
      await axios.put(
        `${homeUrl}/api/orgs/${oid}/configs/audit_log_streaming_destinations`,
        [
          {
            id: "68e44fae-6684-4487-9bef-e42870ffcfc1",
            name: "other",
            url: "https://audit.example.com/events/site",
            token: "Bearer 6f1003e8-3d33-4d45-8a0c-54bcb2a155f1",
          },
        ],
        chimpy
      );
      const scope = nock("https://audit.example.com")
        .post("/events/install", (body) => isCreateDocumentEvent(body, oid))
        .matchHeader(
          "Authorization",
          "Bearer a6c8c7fd-b1d7-431e-8d64-3302f7ea0d74"
        )
        .reply(200)
        .post("/events/site", (body) => isCreateDocumentEvent(body, oid))
        .matchHeader(
          "Authorization",
          "Bearer 6f1003e8-3d33-4d45-8a0c-54bcb2a155f1"
        )
        .reply(200);

      await assert.isFulfilled(
        auditLogger.logEventOrThrow(null, {
          action: "document.create",
          context: {
            site: {
              id: oid,
            },
          },
          details: {
            document: {
              id: "mRM8ydxxLkc6Ewo56jsDGx",
              name: "Project Lollipop",
            },
          },
        })
      );
      assert.isTrue(scope.isDone());
    });

    it("streams installation and site events to multiple destinations", async function () {
      await axios.put(
        `${homeUrl}/api/install/configs/audit_log_streaming_destinations`,
        [
          {
            id: "62c9ed25-1195-48e7-a9f6-0ba164128c20",
            name: "other",
            url: "https://audit.example.com/events/install",
            token: "Bearer a6c8c7fd-b1d7-431e-8d64-3302f7ea0d74",
          },
          {
            id: "4f174ff7-4f56-45c7-b557-712168f7cbec",
            name: "other",
            url: "https://audit.example.com/events/install2",
          },
        ],
        chimpy
      );
      await axios.put(
        `${homeUrl}/api/orgs/${oid}/configs/audit_log_streaming_destinations`,
        [
          {
            id: "68e44fae-6684-4487-9bef-e42870ffcfc1",
            name: "other",
            url: "https://audit.example.com/events/site",
            token: "Bearer 6f1003e8-3d33-4d45-8a0c-54bcb2a155f1",
          },
          {
            id: "555058db-9359-4e41-be6e-6078b72c7bd9",
            name: "other",
            url: "https://audit.example.com/events/site2",
          },
        ],
        chimpy
      );
      const scope = nock("https://audit.example.com")
        .post("/events/install", (body) => isCreateDocumentEvent(body, oid))
        .matchHeader(
          "Authorization",
          "Bearer a6c8c7fd-b1d7-431e-8d64-3302f7ea0d74"
        )
        .reply(200)
        .post("/events/install2", (body) => isCreateDocumentEvent(body, oid))
        .reply(200)
        .post("/events/site", (body) => isCreateDocumentEvent(body, oid))
        .matchHeader(
          "Authorization",
          "Bearer 6f1003e8-3d33-4d45-8a0c-54bcb2a155f1"
        )
        .reply(200)
        .post("/events/site2", (body) => isCreateDocumentEvent(body, oid))
        .reply(200);

      await assert.isFulfilled(
        auditLogger.logEventOrThrow(null, {
          action: "document.create",
          context: {
            site: {
              id: oid,
            },
          },
          details: {
            document: {
              id: "mRM8ydxxLkc6Ewo56jsDGx",
              name: "Project Lollipop",
            },
          },
        })
      );
      assert.isTrue(scope.isDone());
    });

    it("throws when a streaming destination returns a non-2XX response", async function () {
      const scope = nock("https://audit.example.com")
        .post("/events/install")
        .reply(200)
        .post("/events/install2")
        .reply(400, "Bad request")
        .post("/events/site")
        .reply(404, "Not found")
        .post("/events/site2")
        .reply(500, "Internal server error");

      await assert.isRejected(
        auditLogger.logEventOrThrow(null, {
          action: "document.create",
          context: {
            site: {
              id: oid,
            },
          },
          details: {
            document: {
              id: "mRM8ydxxLkc6Ewo56jsDGx",
              name: "Project Lollipop",
            },
          },
        }),
        /encountered errors while streaming audit event/
      );
      assert.isTrue(scope.isDone());
    });

    it("throws when max concurrent requests is exceeded", async function () {
      nock("https://audit.example.com")
        .persist()
        .post(/\/events\/.*/)
        .delay(1000)
        .reply(200);

      // Queue up enough requests so that the next `logEvent` call exceeds the
      // concurrent requests limit; each call creates 4 requests, one for each
      // destination.
      for (let i = 0; i <= 1; i++) {
        void auditLogger.logEventOrThrow(null, {
          action: "document.create",
          context: {
            site: {
              id: oid,
            },
          },
          details: {
            document: {
              id: "mRM8ydxxLkc6Ewo56jsDGx",
              name: "Project Lollipop",
            },
          },
        });
      }

      await assert.isRejected(
        auditLogger.logEventOrThrow(null, {
          action: "document.create",
          context: {
            site: {
              id: oid,
            },
          },
          details: {
            document: {
              id: "mRM8ydxxLkc6Ewo56jsDGx",
              name: "Project Lollipop",
            },
          },
        }),
        /encountered errors while streaming audit event/
      );
    });
  });
});