/**
 * Phase B eBook Generator Store
 * Central state management for intelligent eBook generation workflow
 * Orchestrates all API calls, manages configuration, tracks history
 */

import { writable, derived, get } from "svelte/store";
import * as ebookApi from "../lib/ebookApi.js";

/**
 * @typedef {Object} EbookConfig
 * @property {string} theme - 'dark' | 'light' | 'corporate' | 'bold'
 * @property {number} pageCount - 3-20
 * @property {string} colorPalette - 'standard' | 'vibrant' | 'muted' | 'grayscale'
 * @property {number} fontSizeScale - 0.8 to 1.2
 * @property {string} density - computed: 'sparse' | 'standard' | 'dense' | 'very-dense'
 */

/**
 * @typedef {Object} EbookResult
 * @property {string} id - UUID for override calls
 * @property {Object} content - { title, body }
 * @property {string} html - Full HTML/CSS
 * @property {Object} metadata - theme, density, pages_count, contrast_ratios, etc.
 * @property {Array} pages - Chapter array
 * @property {boolean} can_export
 * @property {boolean} can_override
 */

/**
 * Initial store state
 */
function createEbookStore() {
  const { subscribe, set, update } = writable({
    config: {
      theme: "dark",
      pageCount: 8,
      colorPalette: "standard",
      fontSizeScale: 1.0,
      density: "standard",
    },
    result: null,
    loading: false,
    error: null,
    status: "idle", // 'idle' | 'generating' | 'success' | 'error'
    progress: 0, // 0-100 for generation progress
    progressMessage: "", // Human-readable progress message
    history: {
      configs: [],
      currentIndex: -1,
    },
    themes: [],
    colorPalettes: [],
  });

  return {
    subscribe,

    /**
     * Set selected theme
     * @param {string} theme - Theme ID
     */
    setTheme(theme) {
      validateTheme(theme);
      update((store) => ({
        ...store,
        config: { ...store.config, theme },
        history: addToHistory(store.history, store.config),
      }));
    },

    /**
     * Set page count (3-20) with automatic density computation
     * @param {number} count - Page count
     */
    setPageCount(count) {
      validatePageCount(count);
      const density = computeDensity(count);
      update((store) => ({
        ...store,
        config: { ...store.config, pageCount: count, density },
        history: addToHistory(store.history, store.config),
      }));
    },

    /**
     * Set color palette
     * @param {string} palette - Palette ID
     */
    setColorPalette(palette) {
      validateColorPalette(palette);
      update((store) => ({
        ...store,
        config: { ...store.config, colorPalette: palette },
      }));
    },

    /**
     * Set font size scale (0.8-1.2)
     * @param {number} scale - Font scale
     */
    setFontSizeScale(scale) {
      validateFontSizeScale(scale);
      update((store) => ({
        ...store,
        config: { ...store.config, fontSizeScale: scale },
      }));
    },

    /**
     * Generate eBook from prompt using current config
     * @param {string} prompt - User prompt
     * @returns {Promise<void>}
     */
    async generate(prompt) {
      if (!prompt || prompt.trim().length === 0) {
        throw new Error("Prompt cannot be empty");
      }

      update((store) => ({
        ...store,
        loading: true,
        error: null,
        status: "generating",
        progress: 0,
        progressMessage: "Initializing...",
      }));

      try {
        const currentStore = get({ subscribe });
        const { JobStorage } = await import("../lib/jobStorage.js");

        // Step 1: Initiate generation (returns immediately with jobId)
        console.log("[EBOOK] Initiating generation request...");
        const initResponse = await ebookApi.initiateEbookGeneration({
          prompt,
          theme: currentStore.config.theme,
          pageCount: currentStore.config.pageCount,
          colorPalette: currentStore.config.colorPalette,
          fontSizeScale: currentStore.config.fontSizeScale,
        });

        const { jobId } = initResponse;
        console.log(`[EBOOK] Generation initiated with jobId: ${jobId}`);

        // Save job state for recovery
        JobStorage.save(jobId, {
          prompt,
          config: currentStore.config,
          requestedAt: new Date().toISOString(),
        });

        // Step 2: Poll for completion with progress updates
        const response = await ebookApi.pollEbookCompletion(
          jobId,
          (progress, status, data) => {
            let fullMessage = "";

            // Handle different status types
            if (status === "rate_limited") {
              fullMessage = `⏳ Rate-limited. Waiting to resume... (${Math.round(
                data.backoffMs / 1000
              )}s)`;
              console.warn(`[EBOOK] Rate limited, backing off...`);
            } else if (status === "processing") {
              fullMessage =
                data?.message || `Processing... ${Math.round(progress || 0)}%`;
            } else {
              fullMessage = status || "Processing...";
            }

            console.log(`[EBOOK] Progress: ${progress}% - ${fullMessage}`);
            update((store) => ({
              ...store,
              progress: progress || store.progress,
              progressMessage: fullMessage,
              status: status === "rate_limited" ? "rate_limited" : "generating",
            }));
          }
        );

        // FIX 1.3: Add FRONTEND logging
        console.log("[FRONTEND] Response received:");
        console.log("[FRONTEND] - html present:", !!response.html);
        console.log(
          "[FRONTEND] - html length:",
          response.html?.length || "NULL"
        );
        console.log("[FRONTEND] - title:", response.title);
        console.log("[FRONTEND] - pages:", response.pages?.length || 0);

        // Clear job state on success
        JobStorage.clear();

        update((store) => ({
          ...store,
          result: response,
          loading: false,
          status: "success",
          error: null,
          progress: 100,
          progressMessage: "Complete",
          history: addToHistory(store.history, store.config),
        }));
      } catch (err) {
        console.error("[EBOOK] Generation error:", err);

        // Handle circuit breaker and other errors gracefully
        let errorMessage = err.message;
        if (err.message && err.message.includes("Circuit breaker")) {
          errorMessage =
            "Job generation timeout. Your ebook may have completed - please check manually or try again.";
        }

        update((store) => ({
          ...store,
          error: errorMessage,
          loading: false,
          status: "error",
          progress: 0,
          progressMessage: "",
        }));
        throw err;
      }
    },

    /**
     * Apply style overrides to existing eBook (fast-path)
     * @param {Object} overrides - { theme?, colorPalette?, fontSizeScale? }
     * @param {string} ebookId - eBook ID
     * @returns {Promise<void>}
     */
    async applyOverride(overrides, ebookId) {
      if (!ebookId) {
        throw new Error("eBook ID required for override");
      }

      validateOverrides(overrides);

      update((store) => ({
        ...store,
        loading: true,
        error: null,
      }));

      try {
        const currentStore = get({ subscribe });
        const html = currentStore.result?.html;
        const metadata = currentStore.result?.metadata;

        if (!html || !metadata) {
          throw new Error("No generated eBook found for override");
        }

        const response = await ebookApi.applyOverride({
          ebookId,
          html,
          metadata,
          overrides,
        });

        update((store) => ({
          ...store,
          result: {
            ...store.result,
            ...response,
          },
          loading: false,
          error: null,
        }));
      } catch (err) {
        update((store) => ({
          ...store,
          error: err.message,
          loading: false,
        }));
        throw err;
      }
    },

    /**
     * Undo to previous config state
     * @returns {boolean} True if undo succeeded
     */
    undo() {
      let undoSucceeded = false;
      update((store) => {
        if (store.history.currentIndex > 0) {
          const newIndex = store.history.currentIndex - 1;
          const previousConfig = store.history.configs[newIndex];
          undoSucceeded = true;
          return {
            ...store,
            config: previousConfig,
            history: { ...store.history, currentIndex: newIndex },
          };
        }
        return store;
      });
      return undoSucceeded;
    },

    /**
     * Redo to next config state
     * @returns {boolean} True if redo succeeded
     */
    redo() {
      let redoSucceeded = false;
      update((store) => {
        if (store.history.currentIndex < store.history.configs.length - 1) {
          const newIndex = store.history.currentIndex + 1;
          const nextConfig = store.history.configs[newIndex];
          redoSucceeded = true;
          return {
            ...store,
            config: nextConfig,
            history: { ...store.history, currentIndex: newIndex },
          };
        }
        return store;
      });
      return redoSucceeded;
    },

    /**
     * Reset to initial state
     */
    reset() {
      set({
        config: {
          theme: "dark",
          pageCount: 8,
          colorPalette: "standard",
          fontSizeScale: 1.0,
          density: "standard",
        },
        result: null,
        loading: false,
        error: null,
        status: "idle",
        history: {
          configs: [],
          currentIndex: -1,
        },
        themes: [],
        colorPalettes: [],
      });
    },

    /**
     * Initialize store on app startup
     * Fetch themes metadata
     * @returns {Promise<void>}
     */
    async initialize() {
      try {
        const data = await ebookApi.fetchThemes();
        update((store) => ({
          ...store,
          themes: data.themes || [],
          colorPalettes: data.colorPalettes || [],
        }));
      } catch (err) {
        console.error("Failed to initialize ebookStore", err);
      }
    },
  };
}

/**
 * Validation functions
 */
function validateTheme(theme) {
  const valid = ["dark", "light", "corporate", "bold"];
  if (!valid.includes(theme)) {
    throw new Error(
      `Invalid theme: ${theme}. Must be one of: ${valid.join(", ")}`
    );
  }
}

function validatePageCount(count) {
  const num = Number(count);
  if (num < 3 || num > 20 || !Number.isInteger(num)) {
    throw new RangeError("Page count must be integer between 3 and 20");
  }
}

function validateColorPalette(palette) {
  const valid = ["standard", "vibrant", "muted", "grayscale"];
  if (!valid.includes(palette)) {
    throw new Error(
      `Invalid palette: ${palette}. Must be one of: ${valid.join(", ")}`
    );
  }
}

function validateFontSizeScale(scale) {
  const num = Number(scale);
  if (num < 0.8 || num > 1.2) {
    throw new RangeError("Font scale must be between 0.8 and 1.2");
  }
}

function validateOverrides(overrides) {
  const allowed = ["theme", "colorPalette", "fontSizeScale"];
  const invalid = Object.keys(overrides).filter((k) => !allowed.includes(k));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid override fields: ${invalid.join(", ")}. Allowed: ${allowed.join(
        ", "
      )}`
    );
  }
  // Validate each field if present
  if (overrides.theme) validateTheme(overrides.theme);
  if (overrides.colorPalette) validateColorPalette(overrides.colorPalette);
  if (overrides.fontSizeScale) validateFontSizeScale(overrides.fontSizeScale);
}

/**
 * Compute density classification from page count
 */
function computeDensity(pageCount) {
  if (pageCount <= 5) return "sparse";
  if (pageCount <= 10) return "standard";
  if (pageCount <= 15) return "dense";
  return "very-dense";
}

/**
 * Add config to history, maintaining undo/redo chain
 */
function addToHistory(history, config) {
  // If we're redoing, truncate future history
  const newConfigs = history.configs.slice(0, history.currentIndex + 1);
  newConfigs.push({ ...config });

  // Keep last 50 entries
  if (newConfigs.length > 50) {
    newConfigs.shift();
  }

  return {
    configs: newConfigs,
    currentIndex: newConfigs.length - 1,
  };
}

// Export singleton store
export const ebookStore = createEbookStore();
