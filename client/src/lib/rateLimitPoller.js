/**
 * RateLimitAwarePoller
 * Handles polling with exponential backoff and circuit breaker pattern
 * Gracefully recovers from rate-limit (429) responses
 *
 * Features:
 * - Exponential backoff with jitter
 * - Respects Retry-After headers from server
 * - Circuit breaker pattern (stops after max consecutive rate limits)
 * - Detailed statistics and error tracking
 */

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_RETRIES = 15;
const JITTER_FACTOR = 0.1; // 10% random jitter

export class RateLimitError extends Error {
  constructor(message, backoffMs = INITIAL_BACKOFF_MS) {
    super(message);
    this.name = "RateLimitError";
    this.backoffMs = backoffMs;
    this.retryable = true;
  }
}

export class RateLimitAwarePoller {
  constructor(jobId) {
    this.jobId = jobId;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.consecutiveRateLimits = 0;
    this.totalAttempts = 0;
    this.circuitBreakerOpen = false;
    this.startTime = Date.now();
  }

  /**
   * Check job status with rate-limit awareness
   * @returns {Promise<Object>} Result object with ok flag and data
   */
  async checkStatus() {
    this.totalAttempts++;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`/api/ebook/generate/${this.jobId}/status`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate-limit response
      if (response.status === 429) {
        this.consecutiveRateLimits++;
        return this._handleRateLimit(response);
      }

      // Handle other error statuses
      if (!response.ok) {
        throw new Error(`API error ${response.status}: ${response.statusText}`);
      }

      // Success: reset counters
      this.consecutiveRateLimits = 0;
      this.backoffMs = INITIAL_BACKOFF_MS;

      const data = await response.json();
      return {
        ok: true,
        data,
        headers: {
          rateLimit: response.headers.get("X-RateLimit-Remaining"),
          resetTime: response.headers.get("X-RateLimit-Reset"),
          retryAfter: response.headers.get("Retry-After"),
        },
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Status check timeout (5s exceeded)");
      }
      throw error;
    }
  }

  /**
   * Handle 429 rate-limit response
   * @private
   */
  _handleRateLimit(response) {
    const retryAfterHeader = response.headers.get("Retry-After");

    if (retryAfterHeader) {
      // Use server-provided retry delay
      this.backoffMs = Math.min(
        parseInt(retryAfterHeader) * 1000,
        MAX_BACKOFF_MS
      );
    } else {
      // Exponential backoff with jitter
      const jitter = Math.random() * JITTER_FACTOR * this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 1.5 + jitter, MAX_BACKOFF_MS);
    }

    // Open circuit breaker if too many consecutive rate limits
    if (this.consecutiveRateLimits >= MAX_RETRIES) {
      this.circuitBreakerOpen = true;
      throw new Error(
        `Circuit breaker opened: Too many consecutive rate limits (${this.consecutiveRateLimits}/${MAX_RETRIES}). ` +
          `Job may have completed. Check status manually at /api/ebook/generate/${this.jobId}/status`
      );
    }

    const error = new RateLimitError(
      `Rate limited (attempt ${this.consecutiveRateLimits}/${MAX_RETRIES}). ` +
        `Retrying in ${Math.round(this.backoffMs / 1000)}s`,
      this.backoffMs
    );

    throw error;
  }

  /**
   * Get current backoff duration in milliseconds
   */
  getBackoffMs() {
    return this.backoffMs;
  }

  /**
   * Check if circuit breaker is open
   */
  isCircuitBreakerOpen() {
    return this.circuitBreakerOpen;
  }

  /**
   * Get polling statistics
   */
  getStats() {
    return {
      jobId: this.jobId,
      totalAttempts: this.totalAttempts,
      consecutiveRateLimits: this.consecutiveRateLimits,
      elapsedMs: Date.now() - this.startTime,
      currentBackoffMs: this.backoffMs,
      circuitBreakerOpen: this.circuitBreakerOpen,
    };
  }
}

export default RateLimitAwarePoller;
