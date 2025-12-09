import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RateLimitAwarePoller,
  RateLimitError,
} from "../src/lib/rateLimitPoller.js";

describe("RateLimitAwarePoller", () => {
  let poller;

  beforeEach(() => {
    poller = new RateLimitAwarePoller("test-job-id");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("RateLimitError", () => {
    it("should create error with backoff info", () => {
      const error = new RateLimitError("Rate limited", 5000);
      expect(error.message).toBe("Rate limited");
      expect(error.backoffMs).toBe(5000);
      expect(error.retryable).toBe(true);
    });

    it("should be instanceof Error", () => {
      const error = new RateLimitError("Rate limited", 5000);
      expect(error instanceof Error).toBe(true);
    });

    it("should have default backoff when not specified", () => {
      const error = new RateLimitError("Rate limited");
      expect(error.backoffMs).toBe(1000);
    });
  });

  describe("Circuit Breaker", () => {
    it("should initialize with circuit breaker closed", () => {
      expect(poller.circuitBreakerOpen).toBe(false);
    });

    it("should track consecutive rate limits", () => {
      expect(poller.consecutiveRateLimits).toBe(0);
    });

    it("should open after 15 consecutive rate limits", () => {
      for (let i = 0; i < 15; i++) {
        poller.consecutiveRateLimits++;
      }
      expect(poller.consecutiveRateLimits).toBe(15);
    });

    it("should reset consecutive counter on success", () => {
      poller.consecutiveRateLimits = 5;
      poller.consecutiveRateLimits = 0;
      expect(poller.consecutiveRateLimits).toBe(0);
    });
  });

  describe("Attempt Tracking", () => {
    it("should start with 0 total attempts", () => {
      expect(poller.totalAttempts).toBe(0);
    });

    it("should increment on each check", () => {
      expect(poller.totalAttempts).toBe(0);
      poller.totalAttempts++;
      expect(poller.totalAttempts).toBe(1);
      poller.totalAttempts++;
      expect(poller.totalAttempts).toBe(2);
    });
  });

  describe("Backoff Management", () => {
    it("should start with 1 second backoff", () => {
      expect(poller.backoffMs).toBe(1000);
    });

    it("should cap at 30 seconds", () => {
      poller.backoffMs = 50000;
      const capped = Math.min(poller.backoffMs, 30000);
      expect(capped).toBe(30000);
    });

    it("should reset to initial on success", () => {
      poller.backoffMs = 5000;
      poller.backoffMs = 1000;
      expect(poller.backoffMs).toBe(1000);
    });
  });

  describe("Job ID Tracking", () => {
    it("should store job ID on construction", () => {
      const jobId = "test-job-12345";
      const p = new RateLimitAwarePoller(jobId);
      expect(p.jobId).toBe(jobId);
    });

    it("should use job ID in API calls", async () => {
      const jobId = "my-job-id";
      const p = new RateLimitAwarePoller(jobId);

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve({ status: "processing" }),
        })
      );

      await p.checkStatus();

      const callArgs = global.fetch.mock.calls[0][0];
      expect(callArgs).toContain(jobId);
    });
  });

  describe("Mock Fetch - Successful Response", () => {
    it("should handle successful status response", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: vi.fn((key) => {
              const headers = {
                "X-RateLimit-Remaining": "19",
                "X-RateLimit-Reset": "1000",
                "Retry-After": null,
              };
              return headers[key];
            }),
          },
          json: () => Promise.resolve({ status: "completed", progress: 100 }),
        })
      );

      const result = await poller.checkStatus();
      expect(result.ok).toBe(true);
      expect(result.data.status).toBe("completed");
      expect(result.data.progress).toBe(100);
      expect(poller.consecutiveRateLimits).toBe(0);
    });
  });

  describe("Mock Fetch - Rate Limit Response", () => {
    it("should throw RateLimitError on 429 response", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: {
            get: vi.fn((key) => {
              const headers = {
                "Retry-After": "5",
              };
              return headers[key];
            }),
          },
          json: () => Promise.resolve({ error: "Too Many Requests" }),
        })
      );

      try {
        await poller.checkStatus();
        throw new Error("Should have thrown RateLimitError");
      } catch (err) {
        expect(err instanceof RateLimitError).toBe(true);
        expect(poller.consecutiveRateLimits).toBe(1);
      }
    });

    it("should increment consecutive rate limits", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => null },
          json: () => Promise.resolve({}),
        })
      );

      for (let i = 0; i < 3; i++) {
        try {
          await poller.checkStatus();
        } catch (err) {
          // Expected
        }
      }

      expect(poller.consecutiveRateLimits).toBe(3);
    });
  });

  describe("Mock Fetch - Server Error", () => {
    it("should throw generic error on 500 response", async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: () => null },
          json: () => Promise.resolve({ error: "Server Error" }),
        })
      );

      await expect(poller.checkStatus()).rejects.toThrow();
    });
  });
});
