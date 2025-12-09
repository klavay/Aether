/**
 * Phase B eBook API Client
 * HTTP client for Phase B backend endpoints
 * Handles request/response serialization, error handling, timeouts
 */

const CONFIG = {
  API_BASE_URL: "/api",
  TIMEOUTS: {
    GENERATE: 600000, // 600s (10min) for generate - Large ebooks (20 pages) can take 5+ minutes with Gemini
    OVERRIDE: 10000, // 10s for override
    THEMES: 5000, // 5s for themes
  },
};

/**
 * Fetch with timeout and error handling
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} Response JSON
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(
      `[API] Starting fetch to ${url.replace(CONFIG.API_BASE_URL, "")}`
    );
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    console.log(
      `[API] Response received - Status: ${
        response.status
      }, Content-Type: ${response.headers.get("content-type")}`
    );
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      console.log(
        `[API] Content-Length header: ${(
          parseInt(contentLength) / 1024
        ).toFixed(2)}KB`
      );
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        data.error || `API error ${response.status}: ${response.statusText}`
      );
    }

    // Parse response with detailed error handling
    try {
      console.log(`[API] Attempting to parse JSON response...`);
      const text = await response.text();
      console.log(`[API] Raw response text length: ${text.length} bytes`);
      console.log(`[API] First 200 chars: ${text.substring(0, 200)}`);
      console.log(`[API] Last 100 chars: ${text.substring(text.length - 100)}`);

      const data = JSON.parse(text);
      console.log(
        `[API] JSON parsed successfully. Result keys: ${Object.keys(data).join(
          ", "
        )}`
      );
      if (data.html) {
        console.log(
          `[API] HTML content length: ${(data.html.length / 1024).toFixed(2)}KB`
        );
      }
      if (data.chapters && Array.isArray(data.chapters)) {
        console.log(`[API] Chapters count: ${data.chapters.length}`);
      }
      return data;
    } catch (parseErr) {
      console.error(`[API] JSON parse error:`, parseErr);
      console.error(`[API] Parse error details:`, {
        name: parseErr.name,
        message: parseErr.message,
        stack: parseErr.stack,
      });
      throw parseErr;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    if (err instanceof TypeError) {
      console.error(`[API] TypeError caught:`, err.message);
      throw new Error(`Network error: ${err.message}`);
    }
    console.error(`[API] Error:`, err);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Initiate eBook generation with polling model
 * Returns immediately with jobId
 * @param {Object} payload - { prompt, theme, pageCount, colorPalette, fontSizeScale }
 * @returns {Promise<Object>} { jobId, statusUrl, resultUrl }
 */
export async function initiateEbookGeneration(payload) {
  const response = await fetchWithTimeout(
    `${CONFIG.API_BASE_URL}/ebook/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    10000 // Quick timeout for initiation request
  );

  console.log(`[API] Ebook generation initiated with jobId: ${response.jobId}`);
  return response;
}

/**
 * Check the status of an ebook generation job (single check, no retry)
 * @param {string} jobId - Job ID from initiateEbookGeneration
 * @returns {Promise<Object>} { jobId, status, progress, message, estimatedTimeRemainingSeconds }
 */
export async function checkEbookStatus(jobId) {
  try {
    const status = await fetchWithTimeout(
      `${CONFIG.API_BASE_URL}/ebook/generate/${jobId}/status`,
      { method: "GET" },
      10000 // Quick timeout for status checks
    );

    // Also fetch and log quota status for monitoring
    try {
      const quotaStatus = await getQuotaStatus();
      if (quotaStatus?.quota) {
        console.log(
          `[API] Quota: ${quotaStatus.quota.percentUsed}% used (${quotaStatus.quota.callCount}/${quotaStatus.quota.limit})`
        );
        // Add quota info to status for frontend display
        status.quotaInfo = quotaStatus.quota;
      }
    } catch (quotaErr) {
      console.warn("[API] Failed to fetch quota status:", quotaErr.message);
      // Continue without quota info
    }

    return status;
  } catch (error) {
    // Preserve 429 errors for handling by rate-limit poller
    if (error.message && error.message.includes("429")) {
      throw error;
    }
    throw error;
  }
}

/**
 * Retrieve the result of an ebook generation job
 * @param {string} jobId - Job ID from initiateEbookGeneration
 * @returns {Promise<Object>} Complete ebook object if ready
 */
export async function fetchEbookResult(jobId) {
  return fetchWithTimeout(
    `${CONFIG.API_BASE_URL}/ebook/${jobId}`,
    { method: "GET" },
    30000 // Longer timeout for final result fetch
  );
}

/**
 * Poll for ebook generation completion with rate-limit awareness
 * Repeatedly checks status until complete or error, gracefully handling 429 rate limits
 * @param {string} jobId - Job ID from initiateEbookGeneration
 * @param {Function} onProgress - Callback for progress updates: (progress, message, data) => {}
 * @param {number} maxWaitTime - Maximum wait time in milliseconds (default 3600000 = 1 hour)
 * @returns {Promise<Object>} Complete ebook result when ready
 */
export async function pollEbookCompletion(
  jobId,
  onProgress,
  maxWaitTime = 3600000 // 1 hour
) {
  const { RateLimitAwarePoller } = await import("./rateLimitPoller.js");
  const { JobStorage } = await import("./jobStorage.js");

  const poller = new RateLimitAwarePoller(jobId);
  const startTime = Date.now();

  console.log(`[API] Starting poll for job ${jobId} with rate-limit awareness`);

  while (true) {
    // Check timeout
    if (Date.now() - startTime > maxWaitTime) {
      throw new Error(
        `Ebook generation timeout (exceeded ${maxWaitTime / 1000}s wait time)`
      );
    }

    try {
      // Attempt status check with rate-limit awareness
      const result = await poller.checkStatus();

      if (result.ok) {
        const status = result.data;

        console.log(
          `[API] Job ${jobId} status: ${status.status}, progress: ${status.progress}%`
        );

        // Notify caller of progress
        if (onProgress) {
          onProgress(status.progress, status.status, status);
        }

        if (status.status === "completed") {
          console.log(`[API] Job ${jobId} complete, fetching result...`);
          // Fetch final result
          const finalResult = await fetchEbookResult(jobId);
          console.log(`[API] Job ${jobId} result fetched successfully`);
          JobStorage.update({ status: "completed" });
          return finalResult;
        } else if (status.status === "failed") {
          throw new Error(`Ebook generation failed: ${status.error}`);
        }

        // Wait before next poll
        const pollInterval = 2000; // 2 seconds baseline
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    } catch (error) {
      // Handle rate limit errors with backoff
      const { RateLimitError } = await import("./rateLimitPoller.js");

      if (error instanceof RateLimitError) {
        // Log rate limit but continue polling
        console.warn(`[API] Rate limited:`, error.message);

        if (onProgress) {
          onProgress(undefined, "rate_limited", {
            message: error.message,
            backoffMs: error.backoffMs,
          });
        }

        // Wait with backoff before retrying
        await new Promise((resolve) => setTimeout(resolve, error.backoffMs));
        continue; // Don't increment attempt counter
      }

      // Check for circuit breaker
      if (poller.isCircuitBreakerOpen()) {
        console.error(`[API] Circuit breaker opened:`, error.message);
        throw new Error(
          "Polling circuit breaker opened. Job may have completed. " +
            `Check status manually at /api/ebook/generate/${jobId}/status`
        );
      }

      // Handle transient errors (network, timeout)
      if (
        error.message.includes("timeout") ||
        error.message.includes("Network error")
      ) {
        console.warn(
          `[API] Transient error during polling, will retry: ${error.message}`
        );
        // Wait a bit longer before retrying after transient error
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      // Other errors are fatal
      throw error;
    }
  }
}

/**
 * POST /api/ebook/generate
 * Generate eBook with Phase B pipeline (LEGACY - kept for backward compatibility)
 * Use initiateEbookGeneration + pollEbookCompletion instead
 * @deprecated Use initiateEbookGeneration() + pollEbookCompletion() instead
 */
export async function generateEbook(payload) {
  console.warn(
    "[API] generateEbook() is deprecated. Use initiateEbookGeneration() + pollEbookCompletion() instead."
  );
  return fetchWithTimeout(
    `${CONFIG.API_BASE_URL}/ebook/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    CONFIG.TIMEOUTS.GENERATE
  );
}

/**
 * POST /api/override
 * Apply fast-path style overrides
 * @param {Object} payload - { ebookId, overrides }
 * @returns {Promise<Object>} Updated eBook result
 */
export async function applyOverride(payload) {
  return fetchWithTimeout(
    `${CONFIG.API_BASE_URL}/override`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    CONFIG.TIMEOUTS.OVERRIDE
  );
}

/**
 * GET /api/themes
 * Fetch available themes and color palettes metadata
 * @returns {Promise<Object>} { themes, colorPalettes }
 */
export async function fetchThemes() {
  return fetchWithTimeout(
    `${CONFIG.API_BASE_URL}/themes`,
    { method: "GET" },
    CONFIG.TIMEOUTS.THEMES
  );
}

/**
 * GET /api/quota-status
 * Fetch current Gemini API quota status and job queue metrics
 * @returns {Promise<Object>} { quota, queue, timestamp }
 */
export async function getQuotaStatus() {
  try {
    console.log("[API] Fetching quota status...");
    const response = await fetchWithTimeout(
      `${CONFIG.API_BASE_URL}/quota-status`,
      { method: "GET" },
      5000
    );
    console.log("[API] Quota status:", response.quota);
    return response;
  } catch (error) {
    console.warn("[API] Failed to fetch quota status:", error.message);
    return null;
  }
}
