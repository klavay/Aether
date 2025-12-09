/**
 * Job State Persistence
 * Allows recovery from page reloads or temporary disconnects
 * Stores job state in localStorage for later retrieval
 */

const JOB_STORAGE_KEY = "aether_ebook_job";
const JOB_STORAGE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

export class JobStorage {
  /**
   * Save job state to localStorage
   * @param {string} jobId - Job ID
   * @param {Object} metadata - Additional metadata to store
   */
  static save(jobId, metadata = {}) {
    const jobState = {
      jobId,
      createdAt: Date.now(),
      status: "processing",
      ...metadata,
    };

    try {
      localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(jobState));
      console.log("[JobStorage] Saved job state:", jobId);
    } catch (err) {
      console.warn("[JobStorage] Failed to save:", err.message);
    }
  }

  /**
   * Retrieve job state from localStorage
   * @returns {Object|null} Job state if found and not expired, null otherwise
   */
  static get() {
    try {
      const stored = localStorage.getItem(JOB_STORAGE_KEY);
      if (!stored) return null;

      const job = JSON.parse(stored);

      // Check expiration
      if (Date.now() - job.createdAt > JOB_STORAGE_EXPIRY) {
        this.clear();
        console.log("[JobStorage] Job state expired, clearing");
        return null;
      }

      return job;
    } catch (err) {
      console.error("[JobStorage] Error parsing stored job:", err);
      this.clear();
      return null;
    }
  }

  /**
   * Clear job state from localStorage
   */
  static clear() {
    try {
      localStorage.removeItem(JOB_STORAGE_KEY);
      console.log("[JobStorage] Cleared job state");
    } catch (err) {
      console.warn("[JobStorage] Failed to clear:", err.message);
    }
  }

  /**
   * Update job state metadata
   * @param {Object} metadata - Metadata to update
   */
  static update(metadata) {
    try {
      const job = this.get();
      if (job) {
        const updated = { ...job, ...metadata };
        localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(updated));
      }
    } catch (err) {
      console.warn("[JobStorage] Failed to update:", err.message);
    }
  }

  /**
   * Check if there's a pending job in storage
   * @returns {boolean} True if a valid job is stored
   */
  static hasPendingJob() {
    return this.get() !== null;
  }

  /**
   * Get pending job ID
   * @returns {string|null} Job ID if pending job exists
   */
  static getPendingJobId() {
    const job = this.get();
    return job ? job.jobId : null;
  }
}

export default JobStorage;
