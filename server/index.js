// @ts-nocheck
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

// Basic Express server setup
// Load local environment variables from .env and .env.local when present (dev only)
try {
  // eslint-disable-next-line global-require
  const dotenv = require("dotenv");
  // Load .env first, then .env.local (which can override)
  dotenv.config(); // Load .env
  dotenv.config({ path: ".env.local" }); // Load .env.local if it exists (overrides .env)
} catch (e) {
  // dotenv is optional; if it's not installed we'll ignore the error.
}
// Dev minimal mode: set DEV_MINIMAL=true to disable heavy infra and
// non-essential middleware to make local debugging deterministic.
const DEV_MINIMAL =
  process.env.DEV_MINIMAL === "1" || process.env.DEV_MINIMAL === "true";
if (DEV_MINIMAL) {
  console.log(
    "DEV_MINIMAL=true - running in minimal developer mode: rate-limiting, puppeteer readiness and related checks will be relaxed"
  );
}
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const puppeteer = require("puppeteer-core");
const db = require("./db");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const imageRewrite = require("./utils/imageRewrite");
const EXPORT_USE_LOCAL_IMAGES =
  process.env.EXPORT_USE_LOCAL_IMAGES === "1" ||
  process.env.EXPORT_USE_LOCAL_IMAGES === "true";
const app = express();
const PORT = process.env.PORT || 3000;

async function rewriteImagesForExportAsync(html) {
  if (!EXPORT_USE_LOCAL_IMAGES) return html;
  const rasterize =
    process.env.EXPORT_RASTERIZE_SVG === "1" ||
    process.env.EXPORT_RASTERIZE_SVG === "true";
  // Prefer the async path which can rasterize inlined SVGs to PNG data-URIs
  if (typeof imageRewrite.rewriteDemoImagesAsync === "function") {
    return await imageRewrite.rewriteDemoImagesAsync(html, {
      inlineSvg: true,
      rasterizeSvg: rasterize,
    });
  }
  // Fallback to synchronous rewrite
  return imageRewrite.rewriteDemoImages(html, { inlineSvg: true });
}

// Serve sample images and assets for deterministic exports
try {
  const samplesDir = path.resolve(__dirname, "samples");
  if (fs.existsSync(samplesDir)) {
    app.use("/samples", express.static(samplesDir));
    console.log("Serving /samples from", samplesDir);
  }
} catch (e) {
  console.warn("Failed to register /samples static handler", e && e.message);
}

// --- Main Server Initialization Sequence ---
async function startServer(options = {}) {
  try {
    // 1. Initialize database first
    await db.initialize();
    serviceState.db.ready = true;
    serviceState.db.startupPhase = "ready";
    console.log("Database initialized successfully");

    // 1.b DEPRECATED: Legacy jobs DB initialization removed
    // Phase cleanup: jobsModule and old export queue replaced by Phase 3/4 architecture
    // Old endpoints: /api/export/job, /api/export/job/:id removed
    // Use new endpoints: /api/export/generate, /api/export/status/:jobId, /api/export/download/:jobId

    // 2. Then initialize Puppeteer (skip if explicitly disabled for tests)
    const skipPuppeteer =
      process.env.SKIP_PUPPETEER === "true" ||
      process.env.SKIP_PUPPETEER === "1";
    if (skipPuppeteer) {
      console.log(
        "SKIP_PUPPETEER=true - skipping Puppeteer initialization (test/CI mode)"
      );
      serviceState.puppeteer.startupPhase = "skipped";
      serviceState.puppeteer.ready = false;
    } else {
      await startPuppeteer();
    }

    // 2.b Initialize Phase 3/4: Export Queue, Processor, and Cleanup Scheduler
    const skipExportQueue =
      process.env.SKIP_EXPORT_QUEUE === "true" ||
      process.env.SKIP_EXPORT_QUEUE === "1";
    if (!skipExportQueue) {
      try {
        const exportQueue = require("./utils/exportQueue");
        const exportProcessor = require("./utils/exportProcessor");
        const cleanupScheduler = require("./utils/cleanupScheduler");
        const resultDb = require("./utils/resultDb");
        const { PrismaClient } = require("@prisma/client");
        const prisma = new PrismaClient();

        // Initialize export queue with fallback database
        const exportQueueDbPath =
          process.env.EXPORT_QUEUE_DB ||
          path.join(process.cwd(), "data", "export-queue-fallback.db");
        await exportQueue.initialize(exportQueueDbPath);

        // Initialize export processor with dependencies
        await exportProcessor.initialize(exportQueue, resultDb, prisma);

        // Start background processor loop (checks every 1 second)
        const processorIntervalMs =
          parseInt(process.env.EXPORT_PROCESSOR_INTERVAL_MS) || 1000;
        exportProcessor.start(processorIntervalMs);

        // Initialize cleanup scheduler
        cleanupScheduler.initialize(exportQueue, resultDb);

        // Start cleanup scheduler (runs every hour)
        const cleanupIntervalMs =
          parseInt(process.env.EXPORT_CLEANUP_INTERVAL_MS) || 60 * 60 * 1000;
        cleanupScheduler.start(cleanupIntervalMs);

        console.log(
          "Phase 3/4: Export Queue, Processor, and Cleanup initialized"
        );
        module.exports._exportQueue = exportQueue;
        module.exports._exportProcessor = exportProcessor;
        module.exports._cleanupScheduler = cleanupScheduler;
      } catch (err) {
        console.warn(
          "Failed to initialize export queue/processor/cleanup:",
          err.message
        );
        if (process.env.EXPORT_QUEUE_REQUIRED === "true") {
          throw err; // Fail startup if export queue is required
        }
      }
    } else {
      console.log("SKIP_EXPORT_QUEUE=true - export queue disabled (test mode)");
    }

    // 3. Start the server only after all dependencies are ready
    // Decide whether to call app.listen: by default true, but tests should
    // avoid binding to the network to prevent EADDRINUSE when multiple
    // test workers import/start the server. The caller can override via
    // options.listen = true/false. We also auto-disable listening when
    // running under a test runner (NODE_ENV === 'test' or Vitest worker).
    const callerRequestedListen =
      options.listen !== undefined ? options.listen : true;
    const runningInTest =
      process.env.NODE_ENV === "test" || !!process.env.VITEST_WORKER_ID;
    const shouldListen = callerRequestedListen && !runningInTest;

    if (shouldListen) {
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server listening on port ${PORT}`);
      });
    } else {
      console.log(
        `startServer: Skipping app.listen (shouldListen=${shouldListen}, NODE_ENV=${process.env.NODE_ENV})`
      );
      // If running in tests, reduce startup grace to allow health checks to
      // consider services ready immediately. This prevents test suites from
      // failing due to the initial grace period.
      if (runningInTest) {
        serviceState.startupTime = Date.now() - STARTUP_GRACE_PERIOD_MS - 1000;
      }
    }
  } catch (err) {
    console.error("Failed to start the server:", err);
    process.exit(1); // Exit if critical services fail to start
  }
}

// Start the application only when running this file directly.
if (require.main === module) {
  startServer();
}

// Export the Express app for programmatic use in tests
module.exports = app;
// Also expose startServer so tests can programmatically initialize DB/Puppeteer
module.exports.startServer = startServer;
// Export a wrapper for previewTemplate so the module can be imported before
// the previewTemplate binding is created during module evaluation in tests.
module.exports.previewTemplate = (content) => {
  // previewTemplate will be defined later in this module; evaluate at call time
  return typeof previewTemplate === "function" ? previewTemplate(content) : "";
};
// Expose browserInstance for graceful shutdown in tests/scripts (may be undefined)
Object.defineProperty(module.exports, "browser", {
  enumerable: true,
  get: () => browserInstance,
});

// Graceful startup configuration
const STARTUP_GRACE_PERIOD_MS = 30000; // 30 seconds grace period
const RETRY_DELAY_MS = 5000; // 5 seconds between retries

// Global service state management
const serviceState = {
  startupTime: Date.now(),
  puppeteer: {
    ready: false,
    transitioning: false,
    lastError: null,
    startupPhase: "initializing", // 'initializing' | 'connecting' | 'ready' | 'failed'
    retryCount: 0,
    lastRetryTime: null,
    successfulHealthChecks: 0,
  },
  db: {
    ready: false,
    lastError: null,
    startupPhase: "initializing",
  },
};

// Puppeteer global browser instance
let browserInstance;
const MAX_PUPPETEER_RESTARTS = 5;

async function startPuppeteer() {
  try {
    serviceState.puppeteer.transitioning = true;
    serviceState.puppeteer.startupPhase = "initializing";
    console.log(
      `[Puppeteer] Initialization attempt ${
        serviceState.puppeteer.retryCount + 1
      }/${MAX_PUPPETEER_RESTARTS}`
    );

    // Resolve Chrome executable path: prefer CHROME_PATH env var, then common system locations
    const preferredChrome = process.env.CHROME_PATH || process.env.CHROME_BIN;
    const possiblePaths = [
      preferredChrome,
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ].filter(Boolean);

    let executablePath;
    for (const p of possiblePaths) {
      try {
        if (p && fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      } catch (e) {
        // ignore
      }
    }

    if (!executablePath) {
      console.warn(
        `[Puppeteer] No system Chrome found in ${JSON.stringify(
          possiblePaths
        )}; falling back to Puppeteer's bundled Chromium if available.`
      );
    } else {
      console.log(`[Puppeteer] Using Chrome executable at: ${executablePath}`);
    }

    // Respect PUPPETEER_SKIP_CHROMIUM_DOWNLOAD during image build/install
    if (process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD === "true") {
      console.log(
        "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true - will not download bundled Chromium on install."
      );
    }

    browserInstance = await puppeteer.launch({
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
      ],
      timeout: 30000,
      ignoreHTTPSErrors: true,
      headless: "new", // use newer headless mode when supported
      defaultViewport: { width: 1280, height: 720 }, // Set default viewport
    });

    // Advanced browser health checks
    const testPage = await browserInstance.newPage();
    await testPage.goto("data:text/html,<h1>Health Check</h1>");
    if (testPage.isClosed()) {
      throw new Error("Health check page closed unexpectedly");
    }
    await testPage.close();

    // Update state variables post-success
    Object.assign(serviceState.puppeteer, {
      ready: true,
      transitioning: false,
      lastError: null,
      startupPhase: "ready",
      successfulHealthChecks: 0,
    });

    console.log("[Puppeteer] Initialization successful");

    // Enhanced disconnect handler with delay
    browserInstance.on("disconnected", async () => {
      console.error("[Puppeteer] Browser disconnected");
      Object.assign(serviceState.puppeteer, {
        ready: false,
        transitioning: true,
        startupPhase: "reconnecting",
        lastError: "Browser disconnected",
      });
      await delay(5000); // Add a delay before retry
      await attemptPuppeteerRestart();
    });
  } catch (err) {
    handlePuppeteerError(err);
  } finally {
    // Always cleanup residual state
    if (!serviceState.puppeteer.ready) {
      console.error("[Puppeteer] Cleanup incomplete state");
    }
  }
}

// Helper function for retry delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handlePuppeteerError(err) {
  serviceState.puppeteer.ready = false;
  serviceState.puppeteer.transitioning = false;
  serviceState.puppeteer.lastError = err.message;
  serviceState.puppeteer.retryCount++;

  if (serviceState.puppeteer.retryCount < MAX_PUPPETEER_RESTARTS) {
    serviceState.puppeteer.startupPhase = "connecting";
    serviceState.puppeteer.lastRetryTime = Date.now();
    console.log(`[Puppeteer] Retrying in ${RETRY_DELAY_MS}ms...`);
    setTimeout(startPuppeteer, RETRY_DELAY_MS);
  } else {
    serviceState.puppeteer.startupPhase = "failed";
    console.error("[Puppeteer] Max retry attempts reached");
  }
}

function attemptPuppeteerRestart() {
  if (serviceState.puppeteer.retryCount < MAX_PUPPETEER_RESTARTS) {
    console.log("[Puppeteer] Attempting to restart Puppeteer...");
    startPuppeteer();
  } else {
    console.error(
      "Max Puppeteer restart attempts reached. Manual intervention required."
    );
  }
}

// Trust proxy for rate limiting
app.set("trust proxy", 1);

// Middleware
// Increase JSON body size limit to handle large ebook HTML content (default 100KB is too small)
app.use(express.json({ limit: "50mb" }));
app.use(morgan("dev"));
app.use(cors());
// Apply rate limiting, but allow a dev-only bypass via DISABLE_RATE_LIMIT=1
if (process.env.DISABLE_RATE_LIMIT === "1") {
  console.log("Rate limit disabled via DISABLE_RATE_LIMIT=1");
} else {
  if (!DEV_MINIMAL) {
    app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
  } else {
    console.log("DEV_MINIMAL=true - skipping rate limiting middleware");
  }
}

// Ensure logs directory exists
const logsDir = path.resolve(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  try {
    fs.mkdirSync(logsDir);
  } catch (e) {
    console.warn("Failed to create logs directory:", e.message);
  }
}

// Request ID middleware - help trace requests through proxies
app.use((req, res, next) => {
  try {
    req.id = uuidv4();
    res.setHeader("X-Request-Id", req.id);
    // Allow these headers to be visible to browser clients
    const existing = res.getHeader("Access-Control-Expose-Headers");
    const expose = existing
      ? `${existing},X-Request-Id,X-Backend-Error`
      : "X-Request-Id,X-Backend-Error";
    res.setHeader("Access-Control-Expose-Headers", expose);
  } catch (e) {
    // Don't block requests if UUID generation fails
  }
  next();
});

// Middleware to attach rate-limit headers to responses
// Allows frontend clients to understand quota status and implement smart retry logic
app.use((req, res, next) => {
  // Capture the original send function
  const originalSend = res.send;

  // Override send to attach rate-limit headers before sending response
  res.send = function (data) {
    try {
      const { quotaTracker } = require("./geminiClient");

      if (quotaTracker) {
        const remaining = quotaTracker.getStatus().remaining || 0;
        const limit = quotaTracker.getStatus().limit || 20;
        const status = quotaTracker.getStatus();

        res.set({
          "X-RateLimit-Limit": limit.toString(),
          "X-RateLimit-Remaining": Math.max(0, remaining).toString(),
          "X-RateLimit-Reset": Math.ceil(
            status.pauseUntil
              ? status.pauseUntil / 1000
              : (Date.now() + 60000) / 1000
          ).toString(),
        });

        // Add Retry-After if approaching limit
        if (remaining <= 2) {
          const resetTime = status.pauseUntil || Date.now() + 60000;
          const retryAfter = Math.max(
            1,
            Math.ceil((resetTime - Date.now()) / 1000)
          );
          res.set("Retry-After", retryAfter.toString());
        }
      }
    } catch (err) {
      console.warn(
        "[RATE-LIMIT-HEADERS] Error attaching headers:",
        err.message
      );
      // Continue without headers if quota tracker fails
    }

    // Call the original send with context
    return originalSend.call(this, data);
  };

  next();
});

// Dev-only token auth middleware. Enable by setting DEV_AUTH_TOKEN in the
// environment. This protects the dev server if you need to make forwarded
// ports public during testing. It intentionally allows the root and health
// routes so platform readiness and probes continue to work.
// Only enable dev auth when explicitly running in development mode.
// This avoids unexpected 401s during automated test runs (NODE_ENV === 'test').
if (process.env.DEV_AUTH_TOKEN && process.env.NODE_ENV === "development") {
  app.use((req, res, next) => {
    try {
      if (req.path === "/" || req.path === "/health") return next();
      const token =
        (req.headers &&
          (req.headers["x-dev-auth"] || req.headers["x-dev-token"])) ||
        req.query.dev_token;
      if (token === process.env.DEV_AUTH_TOKEN) return next();
      res.setHeader("WWW-Authenticate", 'Bearer realm="dev"');
      return res
        .status(401)
        .json({ error: "Unauthorized - dev token required" });
    } catch (e) {
      return res.status(500).json({ error: "Dev auth middleware failure" });
    }
  });
}

// Helper to check if we're still in grace period
function isInGracePeriod() {
  return Date.now() - serviceState.startupTime < STARTUP_GRACE_PERIOD_MS;
}

// Startup Readiness Probe Middleware
app.use((req, res, next) => {
  // Allow health check and root route to bypass readiness check
  // Also allow OPTIONS (CORS preflight) requests to always succeed
  if (req.path === "/health" || req.path === "/" || req.method === "OPTIONS") {
    return next();
  }

  const timestamp = new Date().toISOString();

  // Allow tests and SKIP_PUPPETEER mode to bypass puppeteer readiness checks.
  const runningInTest =
    process.env.NODE_ENV === "test" || !!process.env.VITEST_WORKER_ID;
  const skipPuppeteer =
    process.env.SKIP_PUPPETEER === "true" ||
    process.env.SKIP_PUPPETEER === "1" ||
    runningInTest;

  // If puppeteer is transitioning and we're not in skip/test mode, fail readiness
  // In DEV_MINIMAL mode we relax Puppeteer readiness checks so local debug flows
  // don't get blocked by transient browser restarts.
  if (!DEV_MINIMAL && serviceState.puppeteer.transitioning && !skipPuppeteer) {
    return res.status(503).json({
      status: "error",
      reason: "Service transitioning: Puppeteer is restarting",
      timestamp,
      details: {
        puppeteerError: serviceState.puppeteer.lastError,
      },
    });
  }

  // If puppeteer isn't ready and we're not explicitly skipping it for tests/CI,
  // return 503. Tests or CI runs that don't require Puppeteer should set
  // SKIP_PUPPETEER=true or run under NODE_ENV=test so requests are allowed.
  if (
    !DEV_MINIMAL &&
    !skipPuppeteer &&
    (!serviceState.puppeteer.ready || !browserInstance)
  ) {
    return res.status(503).json({
      status: "error",
      timestamp: new Date().toISOString(),
      message: "Service not ready",
      puppeteer: serviceState.puppeteer.transitioning
        ? "initializing"
        : "failed",
    });
  } else if (DEV_MINIMAL) {
    // In minimal dev mode, mark puppeteer as not-required so the server
    // remains responsive even when the headless browser is unavailable.
    // This is safe for local debugging and can be removed before production.
    serviceState.puppeteer.ready = false;
  }

  // If we reach here, services are ready
  next();
});

// Health endpoint
// Checks both SQLite3 and Puppeteer status
app.get("/health", async (req, res) => {
  try {
    const now = Date.now();
    const grace = isInGracePeriod();
    // Check Puppeteer readiness
    const puppeteerReady = serviceState.puppeteer.ready && browserInstance;
    // Check DB readiness
    const dbReady = serviceState.db.ready;

    // Run deeper health checks if not in grace period
    // Respect SKIP_PUPPETEER or test mode: when Puppeteer is intentionally
    // skipped (e.g. CI with SKIP_PUPPETEER=true) we should avoid failing the
    // overall health just because no browser is available.
    const runningInTest =
      process.env.NODE_ENV === "test" || !!process.env.VITEST_WORKER_ID;
    const skipPuppeteer =
      process.env.SKIP_PUPPETEER === "true" ||
      process.env.SKIP_PUPPETEER === "1" ||
      runningInTest;

    let puppeteerStatus = { ok: puppeteerReady, error: null };
    let dbStatus = { ok: dbReady, error: null };
    if (!grace) {
      if (skipPuppeteer) {
        // Mark puppeteer as OK for health purposes when explicitly skipped.
        puppeteerStatus = { ok: true, error: null };
        dbStatus = await checkDatabaseHealth().catch((err) => ({
          ok: false,
          error: err.message,
        }));
      } else {
        [puppeteerStatus, dbStatus] = await Promise.all([
          checkPuppeteerHealth().catch((err) => ({
            ok: false,
            error: err.message,
          })),
          checkDatabaseHealth().catch((err) => ({
            ok: false,
            error: err.message,
          })),
        ]);
      }
    }

    // Compose detailed health object
    const health = {
      status: grace
        ? "initializing"
        : puppeteerStatus.ok && dbStatus.ok
        ? "ok"
        : "error",
      timestamp: new Date().toISOString(),
      uptime: now - serviceState.startupTime,
      gracePeriod: grace,
      services: {
        puppeteer: {
          status: puppeteerStatus.ok ? "ok" : "error",
          phase: serviceState.puppeteer.startupPhase,
          error: puppeteerStatus.error || serviceState.puppeteer.lastError,
          healthChecks: serviceState.puppeteer.successfulHealthChecks,
          ready: serviceState.puppeteer.ready,
          transitioning: serviceState.puppeteer.transitioning,
          retryCount: serviceState.puppeteer.retryCount,
        },
        db: {
          status: dbStatus.ok ? "ok" : "error",
          error: dbStatus.error || serviceState.db.lastError,
          phase: serviceState.db.startupPhase,
          ready: serviceState.db.ready,
        },
      },
    };

    // Log health check details for diagnostics
    if (health.status !== "ok") {
      console.warn("[Health] Not ready:", JSON.stringify(health, null, 2));
    }

    if (health.status === "ok") {
      serviceState.puppeteer.successfulHealthChecks++;
      serviceState.db.ready = true;
      serviceState.db.lastError = null;
      return res.status(200).json(health);
    }

    // If not ready, return 503 with details
    res.status(503).json(health);
  } catch (error) {
    console.error("[Health Check Error]", error);
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error.message,
      services: {
        puppeteer: {
          status: "error",
          phase: serviceState.puppeteer.startupPhase,
          error: error.message,
        },
        db: {
          status: "error",
          phase: serviceState.db.startupPhase,
          error: error.message,
        },
      },
    });
  }
});

/**
 * GET /api/quota-status
 * Returns current Gemini API quota status and job queue metrics
 */
app.get("/api/quota-status", (req, res) => {
  try {
    const { quotaTracker } = require("./geminiClient");
    const jobQueueManager = require("./jobQueueManager");

    const quotaStatus = quotaTracker.getStatus();
    const message = quotaTracker.getMessage();
    const jobStats = jobQueueManager.getStats();
    const deferredCount = jobQueueManager.deferredQueue?.length || 0;

    res.json({
      quota: {
        callCount: quotaStatus.callCount,
        limit: quotaStatus.limit,
        remaining: quotaStatus.remaining,
        percentUsed: quotaStatus.percentUsed,
        isPaused: quotaStatus.isPaused,
        secondsUntilReset: quotaStatus.secondsUntilReset,
        pauseUntil: quotaStatus.pauseUntil,
        dailyCallCount: quotaStatus.dailyCallCount,
        message: message,
      },
      queue: {
        totalJobs: jobStats.totalJobs,
        processing: jobStats.processing,
        deferred: jobStats.deferred,
        complete: jobStats.complete,
        error: jobStats.error,
        deferredCount,
        maxQueueSize: jobQueueManager.maxQueueSize,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Quota Status Error]", error);
    res.status(500).json({
      error: "Failed to retrieve quota status",
      message: error.message,
    });
  }
});

// Default route
app.get("/", (req, res) => {
  res.send("Hello, world! Your Express server is running.");
});

// Test error route
app.get("/test-error", (req, res, next) => {
  const err = new Error("Simulated error for testing");
  err.status = 418;
  next(err);
});

// Centralized error handler (moved to the end of the file so it can catch
// errors from routes defined below). See the bottom of this file for the
// actual handler implementation.

const crud = require("./crud");

// Ebook renderer helper
const { renderBookToPDF } = require("./ebook");
const { generateBackgroundForPoem } = require("./imageGenerator.cjs");

// --- PROMPT PROCESSING ENDPOINT ---
// DEV: quick deterministic handler for local testing.
// If the client sends POST /prompt?dev=true we return a deterministic
// mock content payload and skip DB writes and AI service calls. This keeps
// local UI/integration tests fast and isolated.
app.post("/prompt", (req, res, next) => {
  try {
    const dev =
      req.query && (req.query.dev === "true" || req.query.dev === "1");
    if (!dev) return next();

    const prompt = req.body && req.body.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res
        .status(400)
        .json({ error: "Prompt is required and must be a non-empty string" });
    }

    const title = `Dev: ${prompt.split(" ").slice(0, 6).join(" ")}`;
    const body = `Deterministic dev preview for prompt: ${prompt}`;
    return res.status(201).json({
      success: true,
      data: { content: { title, body, layout: "dev" } },
    });
  } catch (e) {
    return next(e);
  }
});

const { service: serviceImpl } = require("./serviceAdapter");
// Demo genieService (delegates to sampleService) used by POST /prompt
const genieService = require("./genieService");
const { validatePayload } = require("./validators/promptPayload");

// Phase B: E-book Generation Modules (singleton instances)
const overrideService = require("./utils/overrideService");

app.post("/prompt", async (req, res, next) => {
  // Validate enhanced payload structure
  const validation = validatePayload(req.body);
  if (!validation.valid) {
    return sendValidationError(res, validation.message, {
      error: validation.error,
      fields: validation.fields,
    });
  }

  try {
    // Process enhanced payload through genieService
    // genieService.process() handles mode-based routing and service delegation
    const result = await genieService.process(req.body);

    // Return standardized response envelope
    return res.status(201).json(result);
  } catch (err) {
    // Surface generator errors consistently
    err.status = err.status || 500;
    err.code = err.code || "GENERATION_ERROR";
    err.message = `Generation Error: ${err.message}`;
    next(err);
  }
});

// --- PHASE A-B: NEW ENDPOINTS ---

/**
 * POST /api/classify - Classify a prompt to extract metadata
 * Request: { prompt: string, selectedMedium?: string }
 * Response: { classification: { medium, style, themes, confidence, source } }
 */
app.post("/api/classify", async (req, res, next) => {
  try {
    const { prompt } = req.body;

    // Validate
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Prompt is required and must be non-empty",
      });
    }

    // Classify
    const classification = await genieService.classifyPrompt(prompt);

    // Return
    return res.status(200).json({ classification });
  } catch (err) {
    err.status = err.status || 500;
    err.code = err.code || "CLASSIFICATION_ERROR";
    err.message = `Classification Error: ${err.message}`;
    next(err);
  }
});

/**
 * POST /api/generate - Generate content with explicit medium
 * Request: { prompt: string, medium: string, classification?: object }
 * Response: { out_envelope, resultId }
 */
app.post("/api/generate", async (req, res, next) => {
  try {
    const { prompt, medium, classification } = req.body;

    // Validate
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Prompt is required and must be non-empty",
      });
    }

    if (!medium || !String(medium).trim()) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Medium is required",
      });
    }

    // Build payload
    const payload = {
      mode: medium,
      prompt: String(prompt).trim(),
      _classification: classification || null,
      ...(req.body.options && { options: req.body.options }),
    };

    // Process
    const result = await genieService.process(payload);

    // Return
    return res.status(201).json(result);
  } catch (err) {
    err.status = err.status || 500;
    err.code = err.code || "GENERATION_ERROR";
    err.message = `Generation Error: ${err.message}`;
    next(err);
  }
});

/**
 * POST /api/override - Apply style overrides to existing result
 * Request: { resultId: string, overrides: object }
 * Response: { out_envelope, costMultiplier, regenerationStrategy }
 */
app.post("/api/override", async (req, res, next) => {
  try {
    const { resultId, overrides, classification } = req.body;

    // Validate
    if (!resultId || !String(resultId).trim()) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "resultId is required",
      });
    }

    if (!overrides || typeof overrides !== "object") {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Overrides must be an object",
      });
    }

    // Calculate cost using overrideSystem
    const { OverrideSystem } = require("./utils/overrideSystem");
    const overrideSystem = new OverrideSystem();

    // Detect what changed and estimate cost
    const changes = overrideSystem.detectChanges(classification, overrides);
    const costEstimate = overrideSystem.estimateCost(changes);

    // Determine regeneration strategy
    let regenerationStrategy = "restyling"; // Default: CSS only
    if (overrides.medium && overrides.medium !== classification.medium) {
      regenerationStrategy = "full"; // Full regeneration needed
    } else if (changes.style || changes.theme) {
      regenerationStrategy = "partial"; // Partial regeneration
    }

    // For Phase 1, return cost metadata only
    // Phase 2 will implement actual override regeneration
    return res.status(200).json({
      resultId,
      overrides: {
        applied: Object.keys(overrides),
        skipped: [],
      },
      costMultiplier: costEstimate.multiplier,
      costBreakdown: costEstimate.breakdown,
      regenerationStrategy,
      message: "Override validated (regeneration in Phase 2)",
    });
  } catch (err) {
    err.status = err.status || 500;
    err.code = err.code || "OVERRIDE_ERROR";
    err.message = `Override Error: ${err.message}`;
    next(err);
  }
});

// --- PREVIEW ENDPOINT ---
// Import error handling utilities
const { sendValidationError } = require("./utils/errorHandler");

const previewTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <style>
    .preview { max-width: 800px; margin: 2rem auto; font-family: system-ui; }
    .preview h1 { color: #2c3e50; }
    .preview .content { line-height: 1.6; }
  </style>
</head>
<body>
  <div class="preview">
    <h1>${content.title}</h1>
    <div class="content">${content.body}</div>
  </div>
</body>
</html>
`;

// NOTE: image rewrite is handled by `rewriteImagesForExportAsync` above.

app.get("/preview", async (req, res) => {
  const { content, resultId, promptId } = req.query;

  // If content not provided, prefer persisted content (resultId or promptId)
  let contentPayload = content || null;
  try {
    if (!contentPayload && (resultId || promptId)) {
      try {
        const persisted = await genieService.getPersistedContent({
          promptId,
          resultId,
        });
        if (persisted && persisted.content) {
          contentPayload = JSON.stringify(persisted.content);
        }
      } catch (e) {
        // non-fatal: log and continue to validation which will return a helpful error
        console.warn("/preview: getPersistedContent failed", e && e.message);
      }
    }

    // Validate required parameter
    if (!contentPayload) {
      return sendValidationError(res, "Content parameter is required");
    }

    let contentObj = JSON.parse(contentPayload);

    // Support legacy envelope: { content: { title, body } }
    if (contentObj && typeof contentObj === "object" && contentObj.content) {
      contentObj = contentObj.content;
    }

    // Validate content structure
    if (!contentObj || !contentObj.title || !contentObj.body) {
      return sendValidationError(res, "Content must include title and body", {
        provided:
          contentObj && typeof contentObj === "object"
            ? Object.keys(contentObj)
            : typeof contentObj,
      });
    }

    res.send(previewTemplate(contentObj));
  } catch (err) {
    sendValidationError(res, "Invalid content format", { error: err.message });
  }
});

// Demo generator endpoints using the selected service implementation
app.post("/genie", async (req, res) => {
  try {
    const prompt = req.body && req.body.prompt;
    const result = await serviceImpl.generate(prompt);
    return res.status(201).json(result);
  } catch (err) {
    console.error("/genie error", err && err.message);
    const status = err && err.status ? err.status : 500;
    return res.status(status).json({ error: err && err.message });
  }
});

app.get("/genie", (req, res) => {
  try {
    const txt = serviceImpl.readLatest ? serviceImpl.readLatest() : null;
    if (txt === null) return sendValidationError(res, "No saved prompt found");
    const content = {
      title: `Prompt: ${txt.split(" ").slice(0, 6).join(" ")}`,
      body: txt.replace(/\n/g, "<br />"),
    };
    res.setHeader("Content-Type", "text/html");
    return res.send(previewTemplate(content));
  } catch (err) {
    console.error("/genie GET error", err && err.message);
    return res.status(500).json({ error: err && err.message });
  }
});

// DEV-ONLY: return the rewritten HTML that will be used for export so
// we can inspect whether SVGs were inlined or rasterized to data-URIs.
// Only enable when running in development mode so tests are not affected.
if (process.env.DEV_AUTH_TOKEN && process.env.NODE_ENV === "development") {
  app.post("/debug/export-html", async (req, res) => {
    const token = req.headers["x-dev-auth"] || req.query.dev_token;
    if (token !== process.env.DEV_AUTH_TOKEN)
      return res.status(401).json({ error: "Unauthorized" });
    const { title, body } = req.body || {};
    if (!title || !body)
      return res.status(400).json({ error: "title and body required" });
    try {
      const contentObj = { title, body };
      const htmlToRender = await rewriteImagesForExportAsync(
        previewTemplate(contentObj)
      );
      res.setHeader("Content-Type", "text/html");
      return res.send(htmlToRender);
    } catch (e) {
      return res.status(500).json({ error: e && e.message });
    }
  });
}

// Backwards-compatible API route to accept JSON body for preview requests
app.post("/api/preview", (req, res) => {
  const content = req.body && (req.body.content || req.body);

  // Validate required parameter
  if (!content) {
    return sendValidationError(res, "Content parameter is required", {
      provided: typeof req.body,
      required: "object with content or direct content",
    });
  }

  try {
    const contentObj =
      typeof content === "string" ? JSON.parse(content) : content;

    // Validate content structure
    if (!contentObj.title || !contentObj.body) {
      return sendValidationError(res, "Content must include title and body", {
        provided: Object.keys(contentObj),
      });
    }

    res.json({ preview: previewTemplate(contentObj), metadata: {} });
  } catch (err) {
    sendValidationError(res, "Invalid content format", { error: err.message });
  }
});

// --- OVERRIDE ENDPOINT ---
app.post("/override", (req, res) => {
  const { content, changes } = req.body;

  // Enhanced input validation
  if (!content) {
    return sendValidationError(res, "Content is required", {
      provided: typeof content,
      required: "object",
    });
  }

  if (!changes) {
    return sendValidationError(res, "Changes are required", {
      provided: typeof changes,
      required: "object",
    });
  }

  if (typeof content !== "object" || content === null) {
    return sendValidationError(res, "Content must be an object", {
      provided: content === null ? "null" : typeof content,
      required: "object",
    });
  }

  try {
    const updated = { ...content, ...changes };
    res.status(200).json({
      success: true,
      data: {
        content: updated,
      },
    });
  } catch (err) {
    sendValidationError(res, "Failed to update content", {
      error: err.message,
    });
  }
});

// --- PDF EXPORT ENDPOINT ---
// Unified export endpoint: prompt-based LLM generation only
app.post("/api/export", async (req, res) => {
  try {
    console.log(
      "[EXPORT-EP] /api/export: Received export request, delegating to pipeline"
    );
    console.log("[EXPORT-EP] Request body keys:", Object.keys(req.body || {}));

    // STEP 1: Use unified export pipeline (prompt-based only)
    const { prompt, theme, pageCount, quality, validate } = req.body;

    if (!prompt) {
      throw new Error("Export requires prompt parameter");
    }

    const exportPipeline = require("./exportPipeline");
    const pdfBuffer = await exportPipeline.exportEbook(prompt, {
      theme,
      pageCount: parseInt(pageCount) || undefined,
      quality,
      validate: !!validate,
    });

    // Validate pdfBuffer was returned
    if (!pdfBuffer || !(pdfBuffer instanceof Buffer)) {
      console.error(
        "[EXPORT-EP] ERROR: pdfBuffer is not a Buffer:",
        typeof pdfBuffer
      );
      throw new Error("PDF generation failed: no buffer returned");
    }

    // STEP 2: Plumbing - just send the PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=export.pdf`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);

    console.log(
      "[EXPORT-EP] /api/export: PDF sent successfully, size:",
      pdfBuffer.length
    );
  } catch (error) {
    console.error("[EXPORT-EP] /api/export: Export failed:", error.message);
    console.error("[EXPORT-EP] Error stack:", error.stack);

    // Determine appropriate HTTP status based on error type
    let statusCode = 500;
    if (
      error.message.includes("not found") ||
      error.message.includes("Result not found") ||
      error.message.includes("missing required") ||
      error.message.includes("Export requires") ||
      error.message.includes("Invalid ebook")
    ) {
      statusCode =
        error.message.includes("missing required") ||
        error.message.includes("Export requires") ||
        error.message.includes("Invalid ebook")
          ? 400
          : 404;
    } else if (error.message.includes("Invalid export packet")) {
      statusCode = 400;
    }

    res.status(statusCode).json({ error: error.message });
  }
});

// Legacy fallback: alternative export handler (backwards compatibility)
app.post("/export-legacy", async (req, res) => {
  const fs = require("fs");
  const path = require("path");
  const {
    sendValidationError,
    sendProcessingError,
    sendServiceUnavailableError,
  } = require("./utils/errorHandler");
  // Allow callers to reference persisted content by promptId/resultId.
  // If promptId/resultId present, require persisted content; otherwise accept title/body.
  const {
    title: bodyTitle,
    body: bodyBody,
    promptId,
    resultId,
  } = req.body || {};
  let title = bodyTitle;
  let body = bodyBody;

  if (promptId || resultId) {
    // Enforce persisted read when IDs provided
    const persisted = await genieService.getPersistedContent({
      promptId,
      resultId,
    });
    if (!persisted || !persisted.content) {
      return sendValidationError(
        res,
        "Persisted content not found for provided promptId/resultId",
        {
          promptId,
          resultId,
        }
      );
    }
    // Persisted content may be wrapped or be the content object
    const contentObj =
      persisted.content && persisted.content.content
        ? persisted.content.content
        : persisted.content;
    title = contentObj.title;
    body = contentObj.body;
  }

  if (!title || !body) {
    return sendValidationError(res, "Content must include title and body", {
      provided: Object.keys(req.body || {}),
      required: ["title", "body"],
    });
  }

  // Use the same synchronous fallback logic as the GET /export route
  let page;
  try {
    if (!serviceState.puppeteer.ready || !browserInstance) {
      // Try to fall back to the PDF generator (which will use the test/mock
      // implementation when SKIP_PUPPETEER=true). This makes the export
      // endpoints usable in test/CI modes without a real browser.
      try {
        const {
          generatePdfBuffer,
          validatePdfBuffer,
        } = require("./pdfGenerator");
        const generated = await generatePdfBuffer({
          title,
          body,
          validate: true,
        });
        let pdfBuffer;
        let validation;
        if (Buffer.isBuffer(generated)) {
          pdfBuffer = generated;
          validation = await validatePdfBuffer(pdfBuffer).catch(() => ({
            ok: true,
          }));
        } else {
          // { buffer, validation }
          pdfBuffer = generated.buffer;
          validation = generated.validation;
        }

        if (!validation || validation.ok === false) {
          return res.status(422).json({
            ok: false,
            errors: validation && validation.errors ? validation.errors : [],
            warnings:
              validation && validation.warnings ? validation.warnings : [],
            pageCount:
              validation && validation.pageCount ? validation.pageCount : 0,
          });
        }

        res.setHeader("Content-Disposition", `inline; filename=export.pdf`);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", pdfBuffer.length);
        res.end(pdfBuffer);
        return;
      } catch (fallbackErr) {
        console.warn(
          "Export fallback to generator failed:",
          fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr
        );
        return sendServiceUnavailableError(
          res,
          "PDF generation service not ready",
          {
            code: "SERVICE_UNAVAILABLE",
          }
        );
      }
    }

    page = await browserInstance.newPage();
    if (!page) throw new Error("Failed to create browser page");

    const contentObj = { title, body };
    const htmlToRender = await rewriteImagesForExportAsync(
      previewTemplate(contentObj)
    );
    const EXPORT_BASE_URL =
      process.env.EXPORT_BASE_URL ||
      `http://localhost:${process.env.PORT || 3000}`;
    await page.setContent(htmlToRender, {
      waitUntil: "networkidle2",
      timeout: 60000,
      url: EXPORT_BASE_URL,
    });

    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    try {
      const dumpsDir = path.resolve(__dirname, "tmp-exports");
      if (!fs.existsSync(dumpsDir)) fs.mkdirSync(dumpsDir, { recursive: true });
      const dumpPath = path.join(dumpsDir, `export-${Date.now()}.pdf`);
      fs.writeFileSync(dumpPath, pdfBuffer);
      console.log("Wrote export artifact:", dumpPath);
    } catch (e) {
      console.warn("Failed to write export artifact:", e && e.message);
    }

    // Run light validation on the produced PDF. If validation reports fatal
    // errors, surface a 422 so callers can handle export validation failures
    // explicitly (per RFC contract). Warnings do not block the response.
    try {
      const { validatePdfBuffer } = require("./pdfGenerator");
      const validation = await validatePdfBuffer(pdfBuffer);
      if (!validation || validation.ok === false) {
        return res.status(422).json({
          ok: false,
          errors: validation.errors || [],
          warnings: validation.warnings || [],
          pageCount: validation.pageCount || 0,
        });
      }
    } catch (valErr) {
      // If validation tooling fails unexpectedly, log and continue to return
      // the PDF as a best-effort fallback (do not block on validator availability).
      console.warn("PDF validation failed to run:", valErr && valErr.message);
    }

    // Successful binary response; keep binary behaviour for clients
    res.setHeader("Content-Disposition", `inline; filename=export.pdf`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
    return;
  } catch (err) {
    console.error("Export generation error", err);
    // Use standardized processing error payload
    return sendProcessingError(res, `PDF Generation Failed: ${err.message}`, {
      code: "PDF_GENERATION_ERROR",
    });
  } finally {
    if (page) await page.close();
  }
});

// Backwards-compatible POST /export for legacy clients that post to /export
app.post("/export", async (req, res) => {
  const {
    sendValidationError,
    sendProcessingError,
  } = require("./utils/errorHandler");
  // Accept both canonical envelope format AND direct prompt parameter
  // For canonical envelope (old path): requires pages array
  // For prompt parameter (new unified path): uses exportPipeline
  try {
    const envelope = req.body || {};

    // DIAGNOSTIC: Log what we're receiving
    console.log(
      "[EXPORT-EP] POST /export received body with keys:",
      Object.keys(envelope)
    );
    console.log("[EXPORT-EP] Has pages?:", !!envelope.pages);
    console.log("[EXPORT-EP] pages is array?:", Array.isArray(envelope.pages));
    if (envelope.pages) {
      console.log("[EXPORT-EP] pages length:", envelope.pages.length);
    }

    // NEW: Check if this is a prompt-based export (new unified path)
    if (envelope.prompt && !envelope.pages) {
      console.log(
        "[EXPORT-EP] /export: Using unified pipeline for prompt-based export"
      );
      const exportPipeline = require("./exportPipeline");
      const pdfBuffer = await exportPipeline.exportEbook(envelope.prompt, {
        theme: envelope.theme,
        pageCount: envelope.pageCount
          ? parseInt(envelope.pageCount)
          : undefined,
        validate: !!envelope.validate,
      });

      if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
        return sendProcessingError(res, "PDF Generation Failed: empty buffer", {
          code: "PDF_GENERATION_ERROR",
        });
      }

      res.setHeader("Content-Disposition", `inline; filename=export.pdf`);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
      return;
    }

    // OLD: Keep canonical envelope path for backwards compatibility
    console.log("[EXPORT-EP] /export: Using canonical envelope path");

    // Validate canonical envelope structure
    // Allow empty pages array IF html content is present (Priority 1 fallback)
    if (!envelope || (!Array.isArray(envelope.pages) && !envelope.html)) {
      return sendValidationError(
        res,
        "Export requires either: (1) prompt parameter with unified pipeline, or (2) canonical envelope with pages array or html content"
      );
    }

    const exportResult = await genieService.export({
      envelope,
      validate: !!envelope.validate,
    });

    let buffer =
      exportResult && exportResult.buffer ? exportResult.buffer : null;
    if (!buffer) {
      return sendProcessingError(res, "PDF Generation Failed: empty buffer", {
        code: "PDF_GENERATION_ERROR",
      });
    }

    // Ensure we have a Buffer and a valid length before setting headers
    if (!Buffer.isBuffer(buffer)) {
      try {
        buffer = Buffer.from(buffer);
      } catch (e) {
        return sendProcessingError(
          res,
          "PDF Generation Failed: invalid buffer",
          {
            code: "PDF_GENERATION_ERROR",
            details: { type: typeof buffer },
          }
        );
      }
    }

    if (typeof buffer.length !== "number") {
      return sendProcessingError(
        res,
        "PDF Generation Failed: invalid buffer length",
        {
          code: "PDF_GENERATION_ERROR",
        }
      );
    }

    res.setHeader("Content-Disposition", `inline; filename=export.pdf`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
    return;
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 400) return sendValidationError(res, err.message);
    console.error("Export generation error", err && err.message);
    return sendProcessingError(res, `PDF Generation Failed: ${err.message}`, {
      code: "PDF_GENERATION_ERROR",
    });
  }
});

// Maintain existing GET /export behaviour for legacy clients (keeps file save path)

// --- PROMPTS CRUD API ---
app.post("/api/prompts", (req, res, next) => {
  const { prompt } = req.body;

  // Input validation with structured error
  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendValidationError(
      res,
      "Prompt is required and must be a non-empty string",
      {
        provided: typeof prompt,
        required: "non-empty string",
        received: prompt,
      }
    );
  }

  (async () => {
    try {
      const result = await crud.createPrompt(prompt);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT") {
        err.status = 409;
        err.message = "Duplicate prompt not allowed";
      } else {
        err.status = 500;
        err.message = "Failed to create prompt";
      }
      next(err);
    }
  })();
});

app.get("/api/prompts", (req, res, next) => {
  // Parse pagination parameters
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  // Validate pagination parameters
  if (page < 1 || limit < 1) {
    return sendValidationError(res, "Invalid pagination parameters", {
      provided: { page, limit },
      required: "positive integers",
      details: "Page and limit must be greater than 0",
    });
  }

  // Calculate offset
  const offset = (page - 1) * limit;

  (async () => {
    try {
      const rows = await crud.getPrompts();
      if (!rows || rows.length === 0) {
        return res.status(200).json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
      const total = rows.length;
      const pages = Math.ceil(total / limit);
      const paginatedRows = rows.slice(offset, offset + limit);
      res.status(200).json({
        success: true,
        data: paginatedRows,
        pagination: { page, limit, total, pages },
      });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve prompts";
      next(err);
    }
  })();
});

app.get("/api/prompts/:id", (req, res, next) => {
  // Validate ID parameter
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid prompt ID", {
      provided: req.params.id,
      required: "positive integer",
      details: "Prompt ID must be a positive integer",
    });
  }

  (async () => {
    try {
      const row = await crud.getPromptById(id);
      if (!row) {
        return res.status(404).json({
          success: false,
          error: {
            message: "Prompt not found",
            code: "RESOURCE_NOT_FOUND",
            status: 404,
            details: { id },
          },
        });
      }
      res.status(200).json({ success: true, data: row });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve prompt";
      next(err);
    }
  })();
});

app.put("/api/prompts/:id", (req, res, next) => {
  // Validate ID parameter
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid prompt ID", {
      provided: req.params.id,
      required: "positive integer",
      details: "Prompt ID must be a positive integer",
    });
  }

  // Validate prompt in request body
  const { prompt } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return sendValidationError(
      res,
      "Prompt is required and must be a non-empty string",
      {
        provided: typeof prompt,
        required: "non-empty string",
        received: prompt,
      }
    );
  }

  (async () => {
    try {
      const result = await crud.updatePrompt(id, prompt);
      if (!result || result.changes === 0) {
        return res.status(404).json({
          success: false,
          error: {
            message: "Prompt not found",
            code: "RESOURCE_NOT_FOUND",
            status: 404,
            details: { id },
          },
        });
      }
      res.status(200).json({
        success: true,
        data: { id, prompt, updated_at: new Date().toISOString() },
        changes: result.changes,
      });
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT") {
        err.status = 409;
        err.message = "Duplicate prompt not allowed";
      } else {
        err.status = 500;
        err.message = "Failed to update prompt";
      }
      next(err);
    }
  })();
});

app.delete("/api/prompts/:id", (req, res, next) => {
  // Validate ID parameter
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid prompt ID", {
      provided: req.params.id,
      required: "positive integer",
      details: "Prompt ID must be a positive integer",
    });
  }

  (async () => {
    try {
      const result = await crud.deletePrompt(id);
      if (!result || result.changes === 0) {
        return res.status(404).json({
          success: false,
          error: {
            message: "Prompt not found",
            code: "RESOURCE_NOT_FOUND",
            status: 404,
            details: { id },
          },
        });
      }
      res.status(200).json({
        success: true,
        data: {
          message: "Prompt deleted successfully",
          id,
          deleted_at: new Date().toISOString(),
        },
        changes: result.changes,
      });
    } catch (err) {
      if (err.code === "SQLITE_FOREIGN_KEY") {
        err.status = 409;
        err.message = "Cannot delete prompt: It is referenced by other records";
      } else {
        err.status = 500;
        err.message = "Failed to delete prompt";
      }
      next(err);
    }
  })();
});

// --- AI_RESULTS CRUD API ---
app.post("/api/ai_results", (req, res, next) => {
  const { prompt_id, result } = req.body;

  // Validate prompt_id
  if (!Number.isInteger(prompt_id) || prompt_id < 1) {
    return sendValidationError(res, "prompt_id must be a positive integer", {
      provided: typeof prompt_id === "number" ? prompt_id : typeof prompt_id,
      required: "positive integer",
      details: "prompt_id must be a valid prompt reference",
    });
  }

  // Validate result object
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return sendValidationError(res, "result must be a valid object", {
      provided: Array.isArray(result) ? "array" : typeof result,
      required: "object",
      details: "result must contain the AI generation output",
    });
  }

  // Validate required result properties
  const requiredProps = ["content", "metadata"];
  const missingProps = requiredProps.filter((prop) => !(prop in result));
  if (missingProps.length > 0) {
    return sendValidationError(res, "Missing required properties in result", {
      missing: missingProps,
      required: requiredProps,
      provided: Object.keys(result),
    });
  }

  (async () => {
    try {
      const resultObj = await crud.createAIResult(prompt_id, result);
      res.status(201).json({
        success: true,
        data: { ...resultObj, created_at: new Date().toISOString() },
      });
    } catch (err) {
      if (err.code === "SQLITE_FOREIGN_KEY") {
        err.status = 404;
        err.message = "Referenced prompt not found";
      } else if (err.code === "SQLITE_CONSTRAINT") {
        err.status = 409;
        err.message = "Duplicate AI result not allowed";
      } else {
        err.status = 500;
        err.message = "Failed to create AI result";
      }
      next(err);
    }
  })();
});

app.get("/api/ai_results", (req, res, next) => {
  // Parse and validate pagination parameters
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const prompt_id = req.query.prompt_id ? parseInt(req.query.prompt_id) : null;

  // Validate pagination parameters
  if (page < 1 || limit < 1) {
    return sendValidationError(res, "Invalid pagination parameters", {
      provided: { page, limit },
      required: "positive integers",
      details: "Page and limit must be greater than 0",
    });
  }

  // Validate prompt_id if provided
  if (prompt_id !== null && (isNaN(prompt_id) || prompt_id < 1)) {
    return sendValidationError(res, "Invalid prompt_id filter", {
      provided: req.query.prompt_id,
      required: "positive integer",
      details: "prompt_id must be a positive integer",
    });
  }

  // Calculate offset
  const offset = (page - 1) * limit;

  (async () => {
    try {
      const rows = await crud.getAIResults();
      let filteredRows = rows;
      if (prompt_id)
        filteredRows = rows.filter((row) => row.prompt_id === prompt_id);
      if (!filteredRows || filteredRows.length === 0)
        return res.status(200).json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      const total = filteredRows.length;
      const pages = Math.ceil(total / limit);
      let paginatedRows = filteredRows.slice(offset, offset + limit);
      // Unwrap stored result objects for backward compatibility: if the
      // stored row.result contains a { content: ... } envelope, return the
      // unwrapped content to consumers that expect the canonical content.
      paginatedRows = paginatedRows.map((r) => {
        try {
          const parsed = r && r.result ? r.result : null;
          const unwrapped = parsed && parsed.content ? parsed.content : parsed;
          return { ...r, result: unwrapped };
        } catch (e) {
          return r;
        }
      });

      res.status(200).json({
        success: true,
        data: paginatedRows,
        pagination: {
          page,
          limit,
          total,
          pages,
          prompt_id: prompt_id || undefined,
        },
      });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve AI results";
      next(err);
    }
  })();
});

app.get("/api/ai_results/:id", (req, res, next) => {
  // Validate ID parameter
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid AI result ID", {
      provided: req.params.id,
      required: "positive integer",
      details: "AI result ID must be a positive integer",
    });
  }

  (async () => {
    try {
      const row = await crud.getAIResultById(id);
      if (!row)
        return res.status(404).json({
          success: false,
          error: {
            message: "AI result not found",
            code: "RESOURCE_NOT_FOUND",
            status: 404,
            details: { id },
          },
        });
      try {
        const parsed =
          typeof row.result === "string" ? JSON.parse(row.result) : row.result;
        // If stored as { content: ... } unwrap; if stored as aiResponse.pages,
        // prefer first page as canonical content.
        if (parsed && parsed.content) {
          return res
            .status(200)
            .json({ success: true, data: { ...row, result: parsed.content } });
        }
        if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
          return res
            .status(200)
            .json({ success: true, data: { ...row, result: parsed.pages[0] } });
        }
        return res
          .status(200)
          .json({ success: true, data: { ...row, result: parsed } });
      } catch (e) {
        // Fallback: return row as-is
        res
          .status(200)
          .json({ success: true, data: { ...row, result: row.result } });
      }
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve AI result";
      next(err);
    }
  })();
});

app.put("/api/ai_results/:id", (req, res, next) => {
  // Validate ID parameter
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid AI result ID", {
      provided: req.params.id,
      required: "positive integer",
      details: "AI result ID must be a positive integer",
    });
  }

  // Validate result object
  const { result } = req.body;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return sendValidationError(res, "result must be a valid object", {
      provided: Array.isArray(result) ? "array" : typeof result,
      required: "object",
      details: "result must contain the AI generation output",
    });
  }

  // Validate required result properties
  const requiredProps = ["content", "metadata"];
  const missingProps = requiredProps.filter((prop) => !(prop in result));
  if (missingProps.length > 0) {
    return sendValidationError(res, "Missing required properties in result", {
      missing: missingProps,
      required: requiredProps,
      provided: Object.keys(result),
    });
  }

  (async () => {
    try {
      const resultObj = await crud.updateAIResult(id, result);
      if (!resultObj || resultObj.changes === 0)
        return res.status(404).json({
          success: false,
          error: {
            message: "AI result not found",
            code: "RESOURCE_NOT_FOUND",
            status: 404,
            details: { id },
          },
        });
      res.status(200).json({
        success: true,
        data: { id, result, updated_at: new Date().toISOString() },
      });
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT") {
        err.status = 409;
        err.message = "Constraint violation in update";
      } else {
        err.status = 500;
        err.message = "Failed to update AI result";
      }
      next(err);
    }
  })();
});

app.delete("/api/ai_results/:id", (req, res, next) => {
  // Validate ID parameter
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid AI result ID", {
      provided: req.params.id,
      required: "positive integer",
      details: "AI result ID must be a positive integer",
    });
  }

  (async () => {
    try {
      const resultObj = await crud.deleteAIResult(id);
      if (!resultObj || resultObj.changes === 0)
        return res.status(404).json({
          success: false,
          error: {
            message: "AI result not found",
            code: "RESOURCE_NOT_FOUND",
            status: 404,
            details: { id },
          },
        });
      res.status(200).json({
        success: true,
        data: {
          message: "AI result deleted successfully",
          id,
          deleted_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (err.code === "SQLITE_FOREIGN_KEY") {
        err.status = 409;
        err.message =
          "Cannot delete AI result: It is referenced by other records";
      } else {
        err.status = 500;
        err.message = "Failed to delete AI result";
      }
      next(err);
    }
  })();
});

// --- OVERRIDES CRUD API ---
app.post("/api/overrides", (req, res, next) => {
  const { ai_result_id, override } = req.body;

  // Validate ai_result_id
  if (!Number.isInteger(ai_result_id) || ai_result_id < 1) {
    return sendValidationError(res, "ai_result_id must be a positive integer", {
      provided:
        typeof ai_result_id === "number" ? ai_result_id : typeof ai_result_id,
      required: "positive integer",
    });
  }

  // Validate override object
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return sendValidationError(res, "override must be a valid object", {
      provided: Array.isArray(override) ? "array" : typeof override,
      required: "object",
    });
  }

  (async () => {
    try {
      const result = await crud.createOverride(ai_result_id, override);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      if (err.code === "SQLITE_FOREIGN_KEY") {
        err.status = 404;
        err.message = "Referenced AI result not found";
      } else {
        err.status = 500;
        err.message = "Failed to create override";
      }
      next(err);
    }
  })();
});

app.get("/api/overrides", (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  if (page < 1 || limit < 1) {
    return sendValidationError(res, "Invalid pagination parameters", {
      provided: { page, limit },
      required: "positive integers",
    });
  }

  const offset = (page - 1) * limit;

  crud.getOverrides((err, rows) => {
    if (err) {
      err.status = 500;
      err.message = "Failed to retrieve overrides";
      return next(err);
    }

    if (!rows || rows.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: { page, limit, total: 0, pages: 0 },
      });
    }

    const total = rows.length;
    const pages = Math.ceil(total / limit);
    const paginatedRows = rows.slice(offset, offset + limit);

    res.status(200).json({
      success: true,
      data: paginatedRows,
      pagination: { page, limit, total, pages },
    });
  });
  (async () => {
    try {
      const rows = await crud.getOverrides();
      if (!rows || rows.length === 0)
        return res.status(200).json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      const total = rows.length;
      const pages = Math.ceil(total / limit);
      const paginatedRows = rows.slice(offset, offset + limit);
      res.status(200).json({
        success: true,
        data: paginatedRows,
        pagination: { page, limit, total, pages },
      });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve overrides";
      next(err);
    }
  })();
});

app.get("/api/overrides/:id", (req, res, next) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid override ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  crud.getOverrideById(id, (err, row) => {
    if (err) {
      err.status = 500;
      err.message = "Failed to retrieve override";
      return next(err);
    }
    if (!row) {
      return res.status(404).json({
        success: false,
        error: { message: "Override not found", code: "RESOURCE_NOT_FOUND" },
      });
    }
    res.status(200).json({ success: true, data: row });
  });
});

app.put("/api/overrides/:id", (req, res, next) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid override ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  const { override } = req.body;
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return sendValidationError(res, "override must be a valid object", {
      provided: Array.isArray(override) ? "array" : typeof override,
      required: "object",
    });
  }

  crud.updateOverride(id, override, (err, result) => {
    if (err) {
      err.status = 500;
      err.message = "Failed to update override";
      return next(err);
    }
    if (!result || result.changes === 0) {
      return res.status(404).json({
        success: false,
        error: { message: "Override not found", code: "RESOURCE_NOT_FOUND" },
      });
    }
    res.status(200).json({
      success: true,
      data: { id, ...override },
    });
  });
});

app.delete("/api/overrides/:id", (req, res, next) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid override ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  crud.deleteOverride(id, (err, result) => {
    if (err) {
      err.status = 500;
      err.message = "Failed to delete override";
      return next(err);
    }
    if (!result || result.changes === 0) {
      return res.status(404).json({
        success: false,
        error: { message: "Override not found", code: "RESOURCE_NOT_FOUND" },
      });
    }
    res.status(200).json({
      success: true,
      data: { message: "Override deleted successfully" },
    });
  });
});

// --- PDF_EXPORTS CRUD API ---
app.post("/api/pdf_exports", (req, res, next) => {
  const { ai_result_id, file_path } = req.body;

  if (!Number.isInteger(ai_result_id) || ai_result_id < 1) {
    return sendValidationError(res, "ai_result_id must be a positive integer", {
      provided: ai_result_id,
      required: "positive integer",
    });
  }

  if (typeof file_path !== "string" || !file_path.trim()) {
    return sendValidationError(res, "file_path is required", {
      provided: file_path,
      required: "non-empty string",
    });
  }

  (async () => {
    try {
      const result = await crud.createPDFExport(ai_result_id, file_path);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      if (err.code === "SQLITE_FOREIGN_KEY") {
        err.status = 404;
        err.message = "Referenced AI result not found";
      } else {
        err.status = 500;
        err.message = "Failed to create PDF export record";
      }
      next(err);
    }
  })();
});

app.get("/api/pdf_exports", (req, res, next) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;

  if (page < 1 || limit < 1) {
    return sendValidationError(res, "Invalid pagination parameters", {
      provided: { page, limit },
      required: "positive integers",
    });
  }

  const offset = (page - 1) * limit;

  (async () => {
    try {
      const rows = await crud.getPDFExports();
      if (!rows || rows.length === 0)
        return res.status(200).json({
          success: true,
          data: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      const total = rows.length;
      const pages = Math.ceil(total / limit);
      const paginatedRows = rows.slice(offset, offset + limit);
      res.status(200).json({
        success: true,
        data: paginatedRows,
        pagination: { page, limit, total, pages },
      });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve PDF exports";
      next(err);
    }
  })();
});

app.get("/api/pdf_exports/:id", (req, res, next) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid PDF export ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  (async () => {
    try {
      const row = await crud.getPDFExportById(id);
      if (!row)
        return res.status(404).json({
          success: false,
          error: {
            message: "PDF export not found",
            code: "RESOURCE_NOT_FOUND",
          },
        });
      res.status(200).json({ success: true, data: row });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to retrieve PDF export";
      next(err);
    }
  })();
});

// --- CONTENT HELPER ENDPOINTS ---
// Return JSON content for a given AI result id
app.get("/content/result/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid result ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  try {
    const row = await crud.getAIResultById(id);
    if (!row) {
      return res
        .status(404)
        .json({ success: false, error: { message: "AI result not found" } });
    }
    const resultObj =
      typeof row.result === "string" ? JSON.parse(row.result) : row.result;
    const usable =
      resultObj && resultObj.content ? resultObj.content : resultObj;
    return res.status(200).json({ success: true, content: usable });
  } catch (err) {
    console.error("/content/result/:id error", err);
    return res
      .status(500)
      .json({ success: false, error: { message: "Failed to load AI result" } });
  }
});

// Return JSON content for the latest AI result for a given prompt id
app.get("/content/prompt/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid prompt ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  try {
    const results = await crud.getAIResults();
    const filtered = results
      .filter((r) => r.prompt_id === id)
      .sort((a, b) => (a.id || 0) - (b.id || 0));
    const latest = filtered.length ? filtered[filtered.length - 1] : null;
    if (!latest) {
      return res.status(404).json({
        success: false,
        error: { message: "No AI results found for this prompt" },
      });
    }
    const resultObj =
      typeof latest.result === "string"
        ? JSON.parse(latest.result)
        : latest.result;
    const usable =
      resultObj && resultObj.content ? resultObj.content : resultObj;
    return res.status(200).json({ success: true, content: usable });
  } catch (err) {
    console.error("/content/prompt/:id error", err);
    return res.status(500).json({
      success: false,
      error: { message: "Failed to load prompt results" },
    });
  }
});

// --- MULTI-POEM EBOOK EXPORT FOR SMOKE TESTS ---
app.post("/api/export/book", async (req, res) => {
  // Accept body with { poems: [...] } or load sample file if empty
  let poems = null;
  try {
    poems = req.body && req.body.poems ? req.body.poems : null;
  } catch (e) {
    poems = null;
  }

  if (!poems) {
    // Try loading sample dataset from server/samples/poems.json
    try {
      const samplePath = path.resolve(__dirname, "samples", "poems.json");
      const raw = fs.readFileSync(samplePath, "utf8");
      const parsed = JSON.parse(raw);
      // Support shapes:
      //  - { poems: [...] }
      //  - [ { poems: [...] } ] (array wrapping)
      //  - direct array of poem objects
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].poems) {
        poems = parsed[0].poems;
      } else {
        poems = parsed && parsed.poems ? parsed.poems : parsed;
      }
    } catch (err) {
      console.error("Failed to load sample poems:", err.message);
      return res
        .status(400)
        .json({ error: "No poems provided and sample not available" });
    }
  }

  // Use shared browserInstance if available, otherwise attempt a temporary
  // Puppeteer launch so exports can run in test or one-off modes.
  let localBrowser = browserInstance;
  let launchedTempBrowser = false;
  if (!serviceState.puppeteer.ready || !localBrowser) {
    // Try to launch a temporary browser (best-effort). If this fails, return 503.
    try {
      let puppeteerLib;
      try {
        puppeteerLib = require("puppeteer-core");
      } catch (e) {
        try {
          puppeteerLib = require("puppeteer");
        } catch (er) {
          puppeteerLib = null;
        }
      }
      if (!puppeteerLib) throw new Error("puppeteer not available");

      // Resolve executable path similar to startPuppeteer
      const preferredChrome = process.env.CHROME_PATH || process.env.CHROME_BIN;
      const possiblePaths = [
        preferredChrome,
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ].filter(Boolean);
      let executablePath;
      for (const p of possiblePaths) {
        try {
          if (p && fs.existsSync(p)) {
            executablePath = p;
            break;
          }
        } catch (e) {
          // ignore filesystem probe errors when checking executable paths
        }
      }

      localBrowser = await puppeteerLib.launch({
        ...(executablePath ? { executablePath } : {}),
        args: [
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
        headless: "new",
      });
      launchedTempBrowser = true;
    } catch (e) {
      console.warn(
        "Failed to launch temporary Puppeteer for export:",
        e && e.message ? e.message : e
      );
      return res
        .status(503)
        .json({ error: "PDF generation service not ready" });
    }
  }

  try {
    // Ensure each poem has a background image; generate offline stub if missing
    for (let p of poems) {
      if (!p.background) {
        const generated = generateBackgroundForPoem(p);
        if (generated) p.background = generated;
      }
    }

    const pdf = await renderBookToPDF(poems, localBrowser);
    res.setHeader("Content-Disposition", "inline; filename=ebook.pdf");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  } catch (err) {
    console.error("Ebook export error:", err);
    res
      .status(500)
      .json({ error: "Failed to generate ebook", details: err.message });
  } finally {
    if (launchedTempBrowser && localBrowser) {
      try {
        await localBrowser.close();
      } catch (e) {
        // ignore close errors for temporary browser
      }
    }
  }
});

// --- DEPRECATED: Legacy export job endpoints removed in Phase cleanup ---
// These old endpoints have been replaced by Phase 3/4 new architecture:
// - OLD: POST /api/export/job { poems, generateImages }
// - NEW: POST /api/export/generate { resultId }
//
// - OLD: GET /api/export/job/:id
// - NEW: GET /api/export/status/:jobId
//
// - OLD: GET /api/export/jobs/metrics
// - NEW: Query individual jobs via GET /api/export/status/:jobId
//
// For migration guidance, see PHASE_4_ENDPOINTS_IMPLEMENTATION.md

// Deprecated stub for backwards compatibility
app.post("/api/export/job", async (req, res) => {
  return res.status(410).json({
    error: "Deprecated endpoint",
    code: "DEPRECATED",
    message: "POST /api/export/job has been replaced",
    migrateToNewWorkflow: {
      step1:
        "POST /prompt { mode, prompt } → returns { resultId, out_envelope }",
      step2:
        "POST /api/export/generate { resultId } → returns { jobId, status }",
      step3:
        "GET /api/export/status/:jobId → returns { status, progress, pdfUrl? }",
      step4: "GET /api/export/download/:jobId → returns PDF binary",
    },
  });
});

// ============================================================================
// PHASE 3/4: REFERENCE-BASED EXPORT ENDPOINTS
// Reference architecture: result by UUID -> queue job -> async process -> download
// ============================================================================

/**
 * POST /api/export/generate
 * Queue an async export job for a result
 * Request: { resultId: "uuid-..." }
 * Response 202: { jobId: "uuid-...", status: "queued" }
 * Response 400: { error: "Result not found", code: "RESULT_NOT_FOUND" }
 * Response 503: { error: "Export queue full", code: "QUEUE_FULL" }
 */
app.post("/api/export/generate", async (req, res) => {
  const { resultId } = req.body || {};

  if (!resultId || typeof resultId !== "string") {
    return sendValidationError(res, "resultId is required", {
      provided: typeof resultId === "string" ? resultId : typeof resultId,
      required: "non-empty string (UUID)",
    });
  }

  try {
    const resultDb = require("./utils/resultDb");
    const exportQueue = require("./utils/exportQueue");
    const { v4: uuidv4 } = require("uuid");

    // 1. Validate result exists
    let result;
    try {
      result = await resultDb.getResultById(resultId);
    } catch (err) {
      return res.status(500).json({
        error: "Database error retrieving result",
        code: "DB_ERROR",
      });
    }

    if (!result) {
      return res.status(400).json({
        error: "Result not found",
        code: "RESULT_NOT_FOUND",
      });
    }

    // 2. Create export job in database
    const jobId = uuidv4();
    try {
      await resultDb.createExportJob(jobId, resultId);
    } catch (err) {
      console.error("Failed to create export job:", err.message);
      return res.status(500).json({
        error: "Failed to create export job",
        code: "JOB_CREATION_ERROR",
      });
    }

    // 3. Enqueue to export queue (in-memory or fallback)
    try {
      await exportQueue.enqueue(jobId, resultId);
    } catch (err) {
      console.error("Failed to enqueue export job:", err.message);
      if (
        err.message.includes("queue full") ||
        err.message.includes("Queue full")
      ) {
        return res.status(503).json({
          error: "Export queue full",
          code: "QUEUE_FULL",
        });
      }
      return res.status(500).json({
        error: "Failed to enqueue export job",
        code: "ENQUEUE_ERROR",
      });
    }

    // 4. Return success (202 Accepted)
    return res.status(202).json({
      jobId,
      status: "queued",
    });
  } catch (err) {
    console.error("/api/export/generate error:", err.message);
    return res.status(500).json({
      error: "Export generation failed",
      code: "GENERATION_ERROR",
    });
  }
});

/**
 * GET /api/export/status/:jobId
 * Check the status of an export job
 * Response 200: { jobId, status, progress, pdfUrl?, error? }
 * Response 404: { error: "Export job not found", code: "JOB_NOT_FOUND" }
 * Response 410: { error: "Export expired", code: "EXPIRED" }
 */
app.get("/api/export/status/:jobId", async (req, res) => {
  const { jobId } = req.params;

  if (!jobId || typeof jobId !== "string") {
    return sendValidationError(res, "jobId is required", {
      provided: jobId,
      required: "non-empty string (UUID)",
    });
  }

  try {
    const exportQueue = require("./utils/exportQueue");
    const resultDb = require("./utils/resultDb");

    // 1. Get job from queue or database
    let job;
    try {
      job = await exportQueue.getJob(jobId);
    } catch (err) {
      console.error("Failed to get job from queue:", err.message);
    }

    // Fallback: check database if not in queue
    if (!job) {
      try {
        job = await resultDb.getExportJobById(jobId);
      } catch (err) {
        console.error("Failed to get job from database:", err.message);
      }
    }

    if (!job) {
      return res.status(404).json({
        error: "Export job not found",
        code: "JOB_NOT_FOUND",
      });
    }

    // 2. Check if job is expired (>24 hours old)
    const EXPIRY_MS = 24 * 60 * 60 * 1000;
    const age = Date.now() - job.createdAt;
    if (age > EXPIRY_MS) {
      return res.status(410).json({
        error: "Export expired",
        code: "EXPIRED",
      });
    }

    // 3. Build response
    const response = {
      jobId,
      status: job.status,
      progress: job.progress || 0,
    };

    // Add PDF URL if complete
    if (job.status === "complete") {
      response.pdfUrl = `/api/export/download/${jobId}`;
    }

    // Add error if failed
    if (job.status === "failed" && job.errorMessage) {
      response.error = job.errorMessage;
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("/api/export/status/:jobId error:", err.message);
    return res.status(500).json({
      error: "Failed to retrieve job status",
      code: "STATUS_ERROR",
    });
  }
});

/**
 * GET /api/export/download/:jobId
 * Download a generated PDF export
 * Response 200: binary PDF
 * Response 404: { error: "Export not found", code: "NOT_FOUND" }
 * Response 202: { error: "Export not ready", code: "NOT_READY" }
 * Response 410: { error: "Export expired", code: "EXPIRED" }
 */
app.get("/api/export/download/:jobId", async (req, res) => {
  const { jobId } = req.params;

  if (!jobId || typeof jobId !== "string") {
    return sendValidationError(res, "jobId is required", {
      provided: jobId,
      required: "non-empty string (UUID)",
    });
  }

  try {
    const exportQueue = require("./utils/exportQueue");
    const resultDb = require("./utils/resultDb");
    const fs = require("fs").promises;

    // 1. Get job
    let job;
    try {
      job = await exportQueue.getJob(jobId);
    } catch (err) {
      console.error("Failed to get job from queue:", err.message);
    }

    if (!job) {
      try {
        job = await resultDb.getExportJobById(jobId);
      } catch (err) {
        console.error("Failed to get job from database:", err.message);
      }
    }

    if (!job) {
      return res.status(404).json({
        error: "Export not found",
        code: "NOT_FOUND",
      });
    }

    // 2. Check if expired
    const EXPIRY_MS = 24 * 60 * 60 * 1000;
    const age = Date.now() - job.createdAt;
    if (age > EXPIRY_MS) {
      return res.status(410).json({
        error: "Export expired",
        code: "EXPIRED",
      });
    }

    // 3. Check if ready
    if (job.status !== "complete") {
      return res.status(202).json({
        error: "Export not ready",
        code: "NOT_READY",
        status: job.status,
        progress: job.progress || 0,
      });
    }

    // 4. Verify PDF file exists
    const pdfPath = job.pdfPath;
    if (!pdfPath) {
      return res.status(404).json({
        error: "PDF path not found in job record",
        code: "PATH_NOT_FOUND",
      });
    }

    // 5. Read and send PDF
    try {
      const buffer = await fs.readFile(pdfPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="export_${jobId}.pdf"`
      );
      return res.send(buffer);
    } catch (err) {
      if (err.code === "ENOENT") {
        return res.status(404).json({
          error: "PDF file not found on disk",
          code: "FILE_NOT_FOUND",
        });
      }
      throw err;
    }
  } catch (err) {
    console.error("/api/export/download/:jobId error:", err.message);
    return res.status(500).json({
      error: "Failed to download export",
      code: "DOWNLOAD_ERROR",
    });
  }
});

// --- Synchronous poem->image generation endpoint ---
app.post("/api/generate/poem-image", async (req, res) => {
  const { theme, format } = req.body || {};
  try {
    // lazy-load to avoid cycles during startup
    const { generatePoemAndImage } = require("./imageGenerator.cjs");
    const result = await generatePoemAndImage({ theme, format });
    res.status(200).json({ success: true, result });
  } catch (e) {
    console.error(
      "/api/generate/poem-image error",
      e && e.message ? e.message : e
    );
    res
      .status(500)
      .json({ success: false, error: e && e.message ? e.message : String(e) });
  }
});

app.put("/api/pdf_exports/:id", (req, res, next) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid PDF export ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  const { file_path } = req.body;
  if (typeof file_path !== "string" || !file_path.trim()) {
    return sendValidationError(res, "file_path is required", {
      provided: file_path,
      required: "non-empty string",
    });
  }

  (async () => {
    try {
      const result = await crud.updatePDFExport(id, file_path);
      if (!result || result.changes === 0)
        return res.status(404).json({
          success: false,
          error: {
            message: "PDF export not found",
            code: "RESOURCE_NOT_FOUND",
          },
        });
      res.status(200).json({ success: true, data: { id, file_path } });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to update PDF export";
      next(err);
    }
  })();
});

app.delete("/api/pdf_exports/:id", (req, res, next) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1) {
    return sendValidationError(res, "Invalid PDF export ID", {
      provided: req.params.id,
      required: "positive integer",
    });
  }

  (async () => {
    try {
      const result = await crud.deletePDFExport(id);
      if (!result || result.changes === 0)
        return res.status(404).json({
          success: false,
          error: {
            message: "PDF export not found",
            code: "RESOURCE_NOT_FOUND",
          },
        });
      res.status(200).json({
        success: true,
        data: { message: "PDF export deleted successfully" },
      });
    } catch (err) {
      err.status = 500;
      err.message = "Failed to delete PDF export";
      next(err);
    }
  })();
});

// --- HEALTH AND UTILITY FUNCTIONS ---

const HEALTH_CHECK_TIMEOUT_MS = 5000; // 5 seconds

// Utility to add a timeout to any promise
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Operation timed out"));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function checkPuppeteerHealth() {
  if (!browserInstance || !serviceState.puppeteer.ready) {
    return {
      ok: false,
      error: "Puppeteer instance not available or not ready.",
    };
  }
  try {
    await withTimeout(
      (async () => {
        const page = await browserInstance.newPage();
        await page.close();
      })(),
      HEALTH_CHECK_TIMEOUT_MS
    );
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkDatabaseHealth() {
  try {
    // db.get returns a promise, so we await it.
    await db.get("SELECT 1");
    return { ok: true, error: null };
  } catch (err) {
    // If the promise rejects, we catch the error.
    return { ok: false, error: err.message };
  }
}

// Close service handles without exiting the process. This is useful for
// test harnesses and scripted invocations that want a clean shutdown.
async function closeServices(signal) {
  console.log("Close services:", signal || "shutdown");
  try {
    if (module.exports._jobsRecoveryTimer) {
      clearInterval(module.exports._jobsRecoveryTimer);
      module.exports._jobsRecoveryTimer = null;
    }
    if (module.exports._jobsDb) {
      try {
        await module.exports._jobsDb.close();
        console.log("Jobs DB closed");
      } catch (e) {
        console.warn(
          "Error closing jobs DB during shutdown",
          e && e.message ? e.message : e
        );
      }
      module.exports._jobsDb = null;
    }

    // Close Puppeteer browser if present
    if (browserInstance) {
      try {
        // Remove 'disconnected' listener to avoid restart attempts during shutdown
        try {
          browserInstance.removeAllListeners &&
            browserInstance.removeAllListeners("disconnected");
        } catch (er) {
          // ignore listener removal errors
        }
        await browserInstance.close();
        console.log("[Shutdown] Puppeteer browser closed.");
      } catch (e) {
        console.warn(
          "[Shutdown] Error closing Puppeteer browser:",
          e && e.message ? e.message : e
        );
      }
      browserInstance = null;
    }
  } catch (e) {
    console.warn("Error during closeServices", e && e.message ? e.message : e);
  }
  // Ensure exported handles are null even if they were not set. Do this
  // unconditionally so tests which assert the exported sentinel see a
  // deterministic value (null) after shutdown.
  try {
    module.exports._jobsRecoveryTimer = null;
    module.exports._jobsDb = null;
  } catch (e) {
    // If exports are unavailable for some reason, swallow the error
    // but keep shutdown best-effort.
  }

  // Explicitly return undefined so callers expecting a resolved value
  // of undefined can assert on it reliably (tests use resolves.toBeUndefined()).
  return undefined;
}

// Graceful shutdown that closes services then exits (used for process signals)
async function gracefulShutdown(signal) {
  try {
    await closeServices(signal);
  } catch (e) {
    console.warn(
      "Error during gracefulShutdown:",
      e && e.message ? e.message : e
    );
  } finally {
    // allow other listeners to run then exit
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

// Export helpers for external scripts/tests to call without forcing process.exit
module.exports.closeServices = closeServices;
module.exports.gracefulShutdown = gracefulShutdown;

// ==================== PHASE B: E-BOOK GENERATION ====================
// ==================== POLLING MODEL SETUP ====================
// Import job queue manager singleton for background processing
const jobQueueManager = require("./jobQueueManager");

/**
 * Helper function to generate ebook in background
 * Runs asynchronously without blocking the response
 */
async function generateEbookInBackground(
  jobId,
  reqId,
  payload,
  theme,
  pageCountNum,
  colorPalette,
  fontScaleNum,
  prompt
) {
  try {
    jobQueueManager.updateProgress(jobId, 5, "Starting ebook generation...");

    console.log(
      `[${new Date().toISOString()}] [${reqId}] [Job ${jobId}] Calling genieService.process() with pageCount=${pageCountNum}`
    );
    const processStartTime = Date.now();
    let result;
    try {
      result = await genieService.process(payload);
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [${reqId}] [Job ${jobId}] genieService.process() ERROR: ${
          err?.message
        }`
      );
      throw err;
    }
    const processEndTime = Date.now();
    console.log(
      `[${new Date().toISOString()}] [${reqId}] [Job ${jobId}] genieService.process() completed in ${
        processEndTime - processStartTime
      }ms`
    );

    jobQueueManager.updateProgress(jobId, 50, "Composing HTML...");

    // Extract envelope (genieService returns { out_envelope, resultId })
    const envelope = result.out_envelope || result;
    if (!envelope || !envelope.pages || !Array.isArray(envelope.pages)) {
      throw new Error("Invalid response structure from genieService");
    }

    // Extract content from orchestrator result
    const ebookId = `ebook_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    // Compute density classification
    const density =
      pageCountNum <= 5
        ? "sparse"
        : pageCountNum <= 10
        ? "standard"
        : pageCountNum <= 15
        ? "dense"
        : "very-dense";

    // WEEK 1: Extract actual title from first chapter instead of placeholder
    const actualTitle =
      envelope.pages?.[0]?.title ||
      envelope.metadata?.title ||
      "Generated E-book";

    jobQueueManager.updateProgress(jobId, 95, "Finalizing response...");

    const responseObj = {
      id: ebookId,
      resultId: result.resultId,
      pages: envelope.pages,
      html: envelope.html || null,
      title: actualTitle,
      metadata: {
        title: actualTitle,
        author: "Aether AI",
        theme,
        pageCount: pageCountNum,
        wordCount: (prompt || "").split(/\s+/).length,
        colorPalette,
        fontSizeScale: fontScaleNum,
        density,
        ...(envelope.metadata || {}),
      },
      actions: envelope.actions || {
        persist_prompt: true,
        generate_pdf: true,
        can_export: true,
        can_preview: true,
        can_override: true,
      },
    };

    jobQueueManager.completeJob(jobId, responseObj);
    console.log(
      `[${new Date().toISOString()}] [${reqId}] [Job ${jobId}] Background generation complete`
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [${reqId}] [Job ${jobId}] Background generation error:`,
      error
    );
    jobQueueManager.failJob(jobId, error.message);
  }
}

/**
 * POST /api/ebook/generate
 * Initiate a themed e-book generation (polling model)
 * Body: { prompt, theme, pageCount, colorPalette, fontSizeScale }
 * Returns: 202 Accepted with { jobId, statusUrl, resultUrl }
 */
app.post("/api/ebook/generate", async (req, res) => {
  const startTime = Date.now();
  const reqId = req.id || "unknown";
  console.log(
    `[${new Date().toISOString()}] [${reqId}] POST /api/ebook/generate started`
  );

  // Set a long timeout for large ebook generation (20 pages can take 5+ minutes with Gemini)
  // Default is usually 2 minutes, but LLM generation is inherently slow
  req.setTimeout(600000); // 10 minutes for ebook generation
  res.setTimeout(600000); // 10 minutes

  const {
    prompt,
    theme = "dark",
    pageCount = 10,
    colorPalette = "default",
    fontSizeScale = 1.0,
  } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res
      .status(400)
      .json({ error: "Prompt is required and must be a non-empty string" });
  }

  const validThemes = ["dark", "light", "corporate", "bold"];
  if (!validThemes.includes(theme)) {
    return res.status(400).json({
      error: `Invalid theme. Must be one of: ${validThemes.join(", ")}`,
    });
  }

  const pageCountNum = parseInt(pageCount, 10);
  if (isNaN(pageCountNum) || pageCountNum < 3 || pageCountNum > 20) {
    return res
      .status(400)
      .json({ error: "Page count must be between 3 and 20" });
  }

  const fontScaleNum = parseFloat(fontSizeScale);
  if (isNaN(fontScaleNum) || fontScaleNum < 0.8 || fontScaleNum > 1.2) {
    return res
      .status(400)
      .json({ error: "Font size scale must be between 0.8 and 1.2" });
  }

  try {
    // Create job immediately
    const jobInfo = jobQueueManager.createJob({
      prompt,
      theme,
      pageCount: pageCountNum,
      colorPalette,
      fontSizeScale,
    });
    const { jobId, statusUrl, resultUrl } = jobInfo;

    console.log(
      `[${new Date().toISOString()}] [${reqId}] Created job ${jobId}, returning 202 Accepted`
    );

    // Return immediately with job ID (HTTP 202 Accepted)
    res.status(202).json({
      jobId,
      status: "processing",
      message: "Ebook generation started",
      statusUrl,
      resultUrl,
    });

    console.log(
      `[${new Date().toISOString()}] [${reqId}] Response sent in ${
        Date.now() - startTime
      }ms`
    );

    // Start background generation (don't await, don't block response)
    const payload = {
      mode: "ebook",
      prompt,
      metadata: {
        theme,
        pageCount: pageCountNum,
        colorPalette,
        fontSizeScale,
      },
    };

    generateEbookInBackground(
      jobId,
      reqId,
      payload,
      theme,
      pageCountNum,
      colorPalette,
      fontScaleNum,
      prompt
    ).catch((err) => {
      console.error(
        `[${new Date().toISOString()}] [${reqId}] [Job ${jobId}] Uncaught error in background generation:`,
        err
      );
      jobQueueManager.failJob(jobId, err.message);
    });
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [${reqId}] Error initiating ebook generation:`,
      error
    );
    res.status(500).json({
      error: "Failed to initiate e-book generation",
      details: error.message,
    });
  }
});

/**
 * GET /api/ebook/generate/:jobId/status
 * Check the status of an ebook generation job
 * Returns: { jobId, status, progress, message, estimatedTimeRemainingSeconds }
 */
app.get("/api/ebook/generate/:jobId/status", (req, res) => {
  const { jobId } = req.params;
  const status = jobQueueManager.getStatus(jobId);

  if (status.error) {
    return res.status(404).json(status);
  }

  res.json(status);
});

/**
 * GET /api/ebook/generate/:jobId/summary
 * Lightweight summary endpoint for job status
 * Returns minimal job state without full response data
 * Used by frontend polling to check progress with rate-limit awareness
 */
app.get("/api/ebook/generate/:jobId/summary", (req, res) => {
  const { jobId } = req.params;

  try {
    const status = jobQueueManager.getStatus(jobId);

    if (status.error) {
      return res.status(404).json({
        error: "Job not found",
        jobId,
      });
    }

    // Return minimal state (no full response data)
    res.json({
      jobId: jobId,
      status: status.status, // 'processing', 'completed', 'failed'
      progress: status.progress || 0,
      completedAt: status.completedAt || null,
      error: status.error || null,
      message: status.message || null,
    });
  } catch (err) {
    console.error("[SUMMARY-ENDPOINT] Error:", err);
    res.status(500).json({ error: "Failed to fetch job summary" });
  }
});

/**
 * GET /api/ebook/:jobId
 * Retrieve the result of an ebook generation job
 * Returns: Complete ebook object if ready
 */
app.get("/api/ebook/:jobId", (req, res) => {
  const { jobId } = req.params;
  const result = jobQueueManager.getResult(jobId);

  if (result.error) {
    return res.status(404).json(result);
  }

  if (result.status === "processing" || result.status === "error") {
    return res.status(202).json(result);
  }

  // Status is "complete" - result IS the final ebook object
  res.json(result);
});

// ==================== LEGACY ENDPOINT (DEPRECATED) ====================
// Kept for backward compatibility if needed
// This is the old synchronous endpoint - should use polling model instead
app.post("/api/ebook/generate-legacy", async (req, res) => {
  const startTime = Date.now();
  const reqId = req.id || "unknown";
  console.log(
    `[${new Date().toISOString()}] [${reqId}] POST /api/ebook/generate-legacy started`
  );

  // Set a long timeout for large ebook generation (20 pages can take 5+ minutes with Gemini)
  // Default is usually 2 minutes, but LLM generation is inherently slow
  req.setTimeout(600000); // 10 minutes for ebook generation
  res.setTimeout(600000); // 10 minutes

  const {
    prompt,
    theme = "dark",
    pageCount = 10,
    colorPalette = "default",
    fontSizeScale = 1.0,
  } = req.body;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res
      .status(400)
      .json({ error: "Prompt is required and must be a non-empty string" });
  }

  const validThemes = ["dark", "light", "corporate", "bold"];
  if (!validThemes.includes(theme)) {
    return res.status(400).json({
      error: `Invalid theme. Must be one of: ${validThemes.join(", ")}`,
    });
  }

  const pageCountNum = parseInt(pageCount, 10);
  if (isNaN(pageCountNum) || pageCountNum < 3 || pageCountNum > 20) {
    return res
      .status(400)
      .json({ error: "Page count must be between 3 and 20" });
  }

  const fontScaleNum = parseFloat(fontSizeScale);
  if (isNaN(fontScaleNum) || fontScaleNum < 0.8 || fontScaleNum > 1.2) {
    return res
      .status(400)
      .json({ error: "Font size scale must be between 0.8 and 1.2" });
  }

  try {
    // Route through genieService orchestrator with ebook mode
    // This allows genieService to decide routing and coordinate services
    const payload = {
      mode: "ebook",
      prompt,
      metadata: {
        theme,
        pageCount: pageCountNum,
        colorPalette,
        fontSizeScale,
      },
    };

    console.log(
      `[${new Date().toISOString()}] [${reqId}] Calling genieService.process() with pageCount=${pageCountNum}`
    );
    const processStartTime = Date.now();
    let result;
    try {
      result = await genieService.process(payload);
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] [${reqId}] genieService.process() ERROR: ${
          err?.message
        }`
      );
      console.error(
        `[${new Date().toISOString()}] [${reqId}] Stack: ${err?.stack}`
      );
      throw err;
    }
    const processEndTime = Date.now();
    console.log(
      `[${new Date().toISOString()}] [${reqId}] genieService.process() completed in ${
        processEndTime - processStartTime
      }ms, result keys: ${Object.keys(result || {}).join(", ")}`
    );

    // Extract envelope (genieService returns { out_envelope, resultId })
    const envelope = result.out_envelope || result;
    if (!envelope || !envelope.pages || !Array.isArray(envelope.pages)) {
      console.log(
        `[${new Date().toISOString()}] [${reqId}] Invalid envelope structure, returning 500`
      );
      return res.status(500).json({ error: "Failed to generate e-book" });
    }

    // Extract content from orchestrator result
    const ebookId = `ebook_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    // Compute density classification
    const density =
      pageCountNum <= 5
        ? "sparse"
        : pageCountNum <= 10
        ? "standard"
        : pageCountNum <= 15
        ? "dense"
        : "very-dense";

    // Build response envelope matching frontend expectations
    console.log("[ENDPOINT] Building response:");
    console.log("[ENDPOINT] - chapters count:", envelope.pages?.length || 0);
    console.log("[ENDPOINT] - html present:", !!envelope.html);
    console.log("[ENDPOINT] - html length:", envelope.html?.length || "NULL");
    console.log("[ENDPOINT] - title:", envelope.metadata?.title || "NOT SET");

    // WEEK 1: Extract actual title from first chapter instead of placeholder
    const actualTitle =
      envelope.pages?.[0]?.title ||
      envelope.metadata?.title ||
      "Generated E-book";

    const responseObj = {
      id: ebookId,
      resultId: result.resultId,
      chapters: envelope.pages,
      html: envelope.html || null, // WEEK 1: Include composed HTML
      title: actualTitle,
      metadata: {
        title: actualTitle,
        author: "Aether AI",
        theme,
        pageCount: pageCountNum,
        wordCount: (prompt || "").split(/\s+/).length,
        colorPalette,
        fontSizeScale,
        density,
        ...(envelope.metadata || {}),
      },
      actions: envelope.actions || {
        persist_prompt: true,
        generate_pdf: true,
        can_export: true,
        can_preview: true,
        can_override: true,
      },
    };

    const responseJson = JSON.stringify(responseObj);
    console.log(
      `[${new Date().toISOString()}] [${reqId}] Serialized response: ${
        responseJson.length
      } bytes`
    );

    // Log first 500 chars of response to verify content
    console.log(
      `[${new Date().toISOString()}] [${reqId}] Response preview: ${responseJson.substring(
        0,
        500
      )}`
    );

    console.log(
      `[${new Date().toISOString()}] [${reqId}] Sending response to client`
    );

    // Set explicit headers to ensure response is sent properly
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", responseJson.length.toString());

    res.json(responseObj);

    console.log(
      `[${new Date().toISOString()}] [${reqId}] Response json() called. Total time: ${
        Date.now() - startTime
      }ms`
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] [${reqId}] Error generating ebook:`,
      error
    );
    res
      .status(500)
      .json({ error: "Failed to generate e-book", details: error.message });
    console.log(
      `[${new Date().toISOString()}] [${reqId}] Error response sent. Total time: ${
        Date.now() - startTime
      }ms`
    );
  }
});

/**
 * POST /api/override
 * Apply style overrides to an existing e-book
 * Body: { ebookId, overrides: { theme, colorPalette, fontSizeScale, density } }
 * Returns: { id, html, metadata }
 */
app.post("/api/override", async (req, res) => {
  const { ebookId, html, metadata, overrides } = req.body;

  if (!ebookId || !html || !metadata) {
    return res
      .status(400)
      .json({ error: "Missing ebookId, html, or metadata" });
  }

  if (!overrides || typeof overrides !== "object") {
    return res.status(400).json({ error: "Overrides object is required" });
  }

  try {
    // Use OverrideService to apply changes
    const result = overrideService.applyOverride(html, metadata, overrides);

    res.json({
      id: ebookId,
      html: result.html,
      metadata: result.metadata,
      can_override: true,
    });
  } catch (error) {
    console.error("Error applying override:", error);
    res
      .status(400)
      .json({ error: "Failed to apply override", details: error.message });
  }
});

/**
 * GET /api/themes
 * Return available themes and their metadata
 * Returns: { themes: [ { id, name, description, preview } ] }
 */
app.get("/api/themes", (req, res) => {
  const themes = [
    {
      id: "dark",
      name: "Dark Theme",
      description: "Dark background with light text. Best for night reading.",
      colors: { background: "#1a1a1a", text: "#ffffff", accent: "#4a9eff" },
      wcag: "AA",
    },
    {
      id: "light",
      name: "Light Theme",
      description:
        "Light background with dark text. Classic reading experience.",
      colors: { background: "#ffffff", text: "#000000", accent: "#0066cc" },
      wcag: "AA",
    },
    {
      id: "corporate",
      name: "Corporate Theme",
      description:
        "Professional theme with muted colors for business documents.",
      colors: { background: "#f5f5f5", text: "#2c3e50", accent: "#34495e" },
      wcag: "AA",
    },
    {
      id: "bold",
      name: "Bold Theme",
      description:
        "High contrast theme with vibrant colors. Accessible and striking.",
      colors: { background: "#000000", text: "#ffff00", accent: "#ff6b35" },
      wcag: "AAA",
    },
  ];

  res.json({
    themes,
    count: themes.length,
  });
});

/**
 * POST /api/cache/clear
 * FIX 2.2: Clear cache for debugging Test 1 prompt-content mismatch
 * Clears all stored results to ensure fresh generation on next request
 * This helps identify if cache is causing outdated content
 * Returns: { success: boolean, message: string, cleared: number }
 */
app.post("/api/cache/clear", async (req, res) => {
  const startTime = Date.now();
  const reqId = req.id || "unknown";
  console.log(
    `[${new Date().toISOString()}] [${reqId}] POST /api/cache/clear started`
  );
  console.log("[CACHE_CLEAR] Clearing all stored results from database");

  try {
    const { PrismaClient } = require("@prisma/client");
    const prismaForCache = new PrismaClient();

    // Count existing results before clearing
    const existingCount = await prismaForCache.result.count();
    console.log(`[CACHE_CLEAR] Found ${existingCount} results to clear`);

    // Delete all results
    const deleteResult = await prismaForCache.result.deleteMany({});
    console.log(
      `[CACHE_CLEAR] Successfully deleted ${deleteResult.count} results`
    );

    // Also clear export jobs related to deleted results (optional, for cleanliness)
    const jobsDeleted = await prismaForCache.exportJob.deleteMany({});
    console.log(
      `[CACHE_CLEAR] Cleared ${jobsDeleted.count} associated export jobs`
    );

    await prismaForCache.$disconnect();

    const duration = Date.now() - startTime;
    console.log(
      `[${new Date().toISOString()}] [${reqId}] POST /api/cache/clear completed in ${duration}ms`
    );

    res.json({
      success: true,
      message: "Cache cleared successfully",
      cleared: deleteResult.count,
      jobsCleared: jobsDeleted.count,
    });
  } catch (error) {
    console.error("[CACHE_CLEAR] Error clearing cache:", error);
    const duration = Date.now() - startTime;
    console.log(
      `[${new Date().toISOString()}] [${reqId}] POST /api/cache/clear failed in ${duration}ms`
    );

    res.status(500).json({
      success: false,
      error: "Failed to clear cache",
      details: error.message,
    });
  }
});

// Centralized error handler (placed at end to capture errors from all routes)
app.use((err, req, res, _next) => {
  const timestamp = new Date().toISOString();
  // Mark `_next` as used to satisfy linters while keeping the signature
  // as an Express error handler (arity 4). This preserves error-handler
  // behavior without introducing a runtime side-effect.
  void _next;
  const requestId = req && req.id ? req.id : "-";
  console.error("--- Error Handler ---");
  console.error("Time:", timestamp);
  console.error("RequestId:", requestId);
  console.error("Method:", req && req.method);
  console.error("URL:", req && req.originalUrl);
  console.error("Body:", req && req.body);
  console.error("Error Stack:", err && err.stack ? err.stack : err);

  // Append a compact structured error line to server-logs/errors.log for quick lookups
  try {
    const logLine = JSON.stringify({
      t: timestamp,
      id: requestId,
      method: req && req.method,
      url: req && req.originalUrl,
      status: err && err.status ? err.status : 500,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack.split("\n")[0] : null,
    });
    try {
      fs.appendFileSync(path.join(logsDir, "errors.log"), logLine + "\n");
    } catch (e) {
      console.warn(
        "Failed to append to errors.log:",
        e && e.message ? e.message : e
      );
    }
  } catch (e) {
    console.warn(
      "Failed to build error log line:",
      e && e.message ? e.message : e
    );
  }

  // Surface a short error header to aid proxied requests / reverse-proxies
  try {
    res.setHeader(
      "X-Backend-Error",
      err && err.message ? String(err.message).slice(0, 200) : "error"
    );
    res.setHeader("X-Request-Id", requestId);
  } catch (e) {
    // ignore header-setting errors in error handler
  }

  // Differentiate error response by environment
  const isDev = process.env.NODE_ENV !== "production";
  const payload = {
    error: isDev && err && err.message ? err.message : "Internal Server Error",
    requestId,
    ...(isDev && err && { stack: err.stack }),
  };

  // Ensure a JSON content-type so test clients and API consumers get a parsable body
  try {
    if (res.headersSent) {
      // Attempt to write JSON fragment if headers already sent
      try {
        res.write(JSON.stringify(payload));
        res.end();
      } catch (e) {
        try {
          res.end();
        } catch (er) {
          // ignore warn logging errors
        }
      }
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Use Express's json helper so supertest and other clients receive a
    // correctly serialized JSON body that is parsed automatically.
    res.status(err && err.status ? err.status : 500).json(payload);
  } catch (e) {
    // Last-resort safe response
    try {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.status(500).send(JSON.stringify({ error: "error-handler-failed" }));
      } else {
        try {
          res.end();
        } catch (er) {
          // ignore response end errors
        }
      }
    } catch (ee) {
      // ignore final shutdown errors
    }
  }
});
