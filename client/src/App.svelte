<script>
  // Basic App component for AetherPress Svelte frontend
  import { appState } from './stores/appState.js';
  import { modeStore } from './stores/modeStore.js';
  import { promptStore, setGenerating, setError } from './stores/promptStore.js';
  import ModeSwitcher from './components/ModeSwitcher.svelte';
  import MetadataSection from './components/MetadataSection.svelte';
  import { contentStore } from './stores/index.js';
  import { submitPrompt as apiSubmitPrompt } from './lib/api.js';
  import ExportButton from './components/ExportButton.svelte';
  
  // Phase B: E-book styling components
  import { ebookStore } from './stores/ebookStore.js';
  import ThemeSelector from './components/ThemeSelector.svelte';
  import PageCountSlider from './components/PageCountSlider.svelte';
  import OverrideForm from './components/OverrideForm.svelte';
  import ThemePreview from './components/ThemePreview.svelte';

  // Fetch backend health status on mount
  let health = null;
  let apiError = null;
  let aiResult = '';
  
  // Subscribe to promptStore
  $: prompt = $promptStore.prompt;
  $: loadingAI = $promptStore.generating;
  
  // Subscribe to ebookStore
  $: ebookConfig = $ebookStore.config;
  $: ebookResult = $ebookStore.result;
  $: ebookLoading = $ebookStore.loading;
  $: ebookError = $ebookStore.error;
  $: ebookProgress = $ebookStore.progress;
  $: ebookProgressMessage = $ebookStore.progressMessage;
  $: ebookStatus = $ebookStore.status;

  async function checkHealth() {
    appState.update(state => ({ ...state, loading: true, error: null }));
    try {
      const res = await fetch('/health'); // Use relative path for Vite proxy
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      health = data.status;
      appState.update(state => ({ ...state, loading: false }));
    } catch (err) {
      apiError = err.message;
      appState.update(state => ({ ...state, loading: false, error: err.message }));
    }
  }

  async function submitPrompt() {
    aiResult = '';
    apiError = null;
    setGenerating(true);
    try {
  // Use shared API helper which normalizes the response shape
  const result = await apiSubmitPrompt(prompt);
      // result is normalized to { content, copies, metadata, promptId, resultId }
      aiResult = JSON.stringify(result, null, 2);
      // Populate the shared content store so UI components (ExportButton)
      // can reactively enable export and other actions.
      // `result` is an envelope: { content, copies, metadata, promptId, resultId }
      // Export expects a content object with top-level { title, body }.
      // Unwrap common envelope shapes to ensure the store contains the
      // expected payload shape (defensive but minimal change).
      const contentToStore =
        (result && (result.content || (result.data && result.data.content))) ||
        result ||
        null;
      contentStore.set(contentToStore);
    } catch (err) {
      setError(err.message);
      apiError = err.message;
    } finally {
      setGenerating(false);
    }
  }

  checkHealth();
</script>

<main>
  <div class="header-info">
    <p class="title">AetherPress (V0.1)</p>
    <p class="motto">From Imagination to Publication (It's a snap!)</p>
    <p>Current user: {$appState.user ? $appState.user : 'None'}</p>
    <p>Backend health: {health ? health : 'Checking...'}</p>
  </div>

  <section class="main-content">
    <h2>AI-Powered eBook Creation</h2>
    <ModeSwitcher />
    
    {#if $modeStore.current === 'demo'}
      <MetadataSection />
    {/if}
    
    <!-- PHASE B: E-BOOK STYLING SECTION -->
    {#if $modeStore.current === 'ebook'}
      <div class="phase-b-section">
        <h3>E-book Styling (Phase B)</h3>
        <div class="ebook-controls">
          <div class="control-group">
            <ThemeSelector 
              selectedTheme={ebookConfig.theme}
              onChange={(theme) => ebookStore.setTheme(theme)}
            />
          </div>
          
          <div class="control-group">
            <PageCountSlider 
              pageCount={ebookConfig.pageCount}
              onChange={(count) => ebookStore.setPageCount(count)}
            />
          </div>
          
          {#if ebookResult && ebookResult.html}
            <div class="control-group">
              <OverrideForm 
                onApply={(overrides) => ebookStore.applyOverride(overrides, ebookResult.id)}
                isLoading={ebookLoading}
              />
            </div>
          {/if}
        </div>
        
        <div class="ebook-prompt-form">
          <label for="ebook-prompt">Enter your prompt:</label>
          <textarea 
            id="ebook-prompt" 
            bind:value={prompt} 
            rows="3" 
            class="prompt-input"
            placeholder="e.g., A children's mystery tale about a blind mouse detective..."
          ></textarea>
          <button 
            class="generate-button"
            on:click={() => ebookStore.generate(prompt)}
            disabled={ebookLoading || !prompt.trim()}
          >
            {ebookLoading ? 'Generating eBook...' : 'Generate eBook'}
          </button>
        </div>
        
        {#if ebookLoading}
          <p class="loading-message">Generating e-book...</p>
          {#if ebookProgressMessage}
            <p class="progress-message">{ebookProgressMessage}</p>
          {/if}
        {/if}
        
        {#if ebookError}
          <p class="error-message">Error: {ebookError}</p>
        {/if}
        
        {#if ebookResult}
          <div class="result-section">
            <h4>✅ eBook Generated Successfully!</h4>
            {#if ebookResult.title}
              <p><strong>Title:</strong> {ebookResult.title}</p>
            {:else if ebookResult.metadata && ebookResult.metadata.title}
              <p><strong>Title:</strong> {ebookResult.metadata.title}</p>
            {/if}
            {#if ebookResult.chapters}
              <p><strong>Chapters:</strong> {ebookResult.chapters.length}</p>
            {/if}
            {#if ebookResult.metadata}
              <p><strong>Theme:</strong> {ebookResult.metadata.theme}</p>
              <p><strong>Pages:</strong> {ebookResult.metadata.pageCount}</p>
            {/if}
            
            <div class="export-button-wrapper">
              <button 
                class="export-btn"
                on:click={async () => {
                  try {
                    // Export expects: { pages, metadata, actions }
                    // Transform backend response to export format
                    const exportPayload = {
                      pages: ebookResult.chapters || [],
                      html: ebookResult.html || null,
                      metadata: ebookResult.metadata || {},
                      actions: ebookResult.actions || {},
                    };
                    // Use the export function from api
                    const { exportToPdf } = await import('./lib/api.js');
                    await exportToPdf(exportPayload);
                  } catch (err) {
                    ebookStore.update(s => ({...s, error: err.message}));
                  }
                }}
              >
                📥 Export as PDF
              </button>
            </div>
            
            {#if ebookResult.html}
              <div class="preview-container">
                <h5>Preview</h5>
                <div class="ebook-preview">
                  {@html ebookResult.html}
                </div>
              </div>
            {:else if ebookResult.chapters}
              <!-- Fallback: Show chapters array if HTML missing -->
              <div class="preview-container">
                <h5>Preview (Chapters)</h5>
                <div class="ebook-chapters">
                  {#each ebookResult.chapters as chapter}
                    <div class="chapter">
                      <h6>{chapter.title}</h6>
                      <p>{chapter.content}</p>
                    </div>
                  {/each}
                </div>
              </div>
            {:else if ebookResult.metadata}
              <!-- Fallback: Show theme preview -->
              <div class="preview-container">
                <h5>Preview</h5>
                <ThemePreview 
                  theme={ebookConfig.theme}
                  pageCount={ebookResult.chapters ? ebookResult.chapters.length : 1}
                />
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    
    <form on:submit|preventDefault={submitPrompt}>
      <label for="prompt">Enter your creative prompt:</label>
      <textarea id="prompt" bind:value={prompt} rows="4" class="prompt-input"></textarea>
      <button type="submit" disabled={loadingAI || !prompt.trim()} class="generate-button">Generate</button>
    </form>
    {#if loadingAI}
      <p>Generating with AI...</p>
    {/if}
    {#if aiResult}
      <div style="margin-top:1.5rem; padding:1rem; border:1px solid #ccc; border-radius:8px; background:#fafafa;">
        <h3>AI Result</h3>
        <pre style="white-space:pre-wrap;">{aiResult}</pre>

        <!-- Action UI: Export wired to ExportButton; Edit still stubbed -->
        <div class="action-buttons" style="margin-top:0.75rem; display:flex; gap:0.5rem;">
          <ExportButton />

          <button
            class="stub-button"
            aria-disabled="true"
            disabled
            title="Edit — coming soon"
            data-testid="edit-button-stub"
          >
            Edit
          </button>
        </div>
      </div>
    {/if}
    {#if apiError}
      <p style="color: red">API Error: {apiError}</p>
    {/if}
  </section>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 4rem;
    font-family: system-ui, sans-serif;
  }
  .header-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .header-info p {
    margin: 0;
    font-size: 1rem;
  }
  .title {
    color: #ff3e00;
    font-weight: 500;
  }
  .motto {
    color: #444;
    font-style: italic;
  }
  p {
    color: #444;
  }
  .main-content {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    padding: 2rem;
    width: 100%;
    max-width: 800px;
  }

  /* Phase B styles */
  .phase-b-section {
    background: #f8f9ff;
    border: 2px solid #e0e7ff;
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }
  
  .phase-b-section h3 {
    margin-top: 0;
    color: #4f46e5;
    font-size: 1.2rem;
  }
  
  .ebook-controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  
  .control-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .loading-message {
    color: #4f46e5;
    font-weight: 500;
    margin: 1rem 0;
  }
  
  .progress-message {
    color: #9333ea;
    font-size: 0.95rem;
    margin: 0.5rem 0 1rem 0;
    padding: 0.5rem 1rem;
    background: #fdf4ff;
    border-left: 3px solid #9333ea;
    border-radius: 4px;
    font-weight: 500;
  }
  
  .error-message {
    color: #dc2626;
    background: #fee2e2;
    padding: 0.75rem;
    border-radius: 6px;
    margin: 1rem 0;
  }
  
  .result-section {
    background: #f0fdf4;
    border: 2px solid #22c55e;
    border-radius: 8px;
    padding: 1.5rem;
    margin-top: 1.5rem;
  }
  
  .result-section h4 {
    color: #16a34a;
    margin-top: 0;
    font-size: 1.1rem;
  }
  
  .result-section p {
    margin: 0.5rem 0;
    color: #15803d;
  }
  
  .export-button-wrapper {
    margin-top: 1rem;
    display: flex;
    gap: 0.75rem;
  }
  
  .export-btn {
    background: #22c55e;
    color: white;
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.2s;
    flex: 1;
  }
  
  .export-btn:hover {
    background: #16a34a;
  }
  
  .export-btn:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .preview-container {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 1rem;
    margin-top: 1.5rem;
  }
  
  .preview-container h5 {
    margin-top: 0;
    color: #374151;
  }


  .ebook-prompt-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 1.5rem;
    padding: 1rem;
    background: #f0f7ff;
    border: 1px solid #bfdbfe;
    border-radius: 8px;
  }

  .ebook-prompt-form label {
    font-weight: 600;
    color: #1e40af;
    font-size: 0.95rem;
  }

  form {
    margin-top: 1.5rem;
  }

  .prompt-input {
    width: 100%;
    margin-top: 0.5rem;
    font-size: 1rem;
    font-family: inherit;
    border-radius: 6px;
    border: 1px solid #ccc;
    padding: 0.75rem;
    resize: vertical;
    min-height: 120px;
  }

  .generate-button {
    margin-top: 1rem;
  }
  button {
    background: #ff3e00;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1.5rem;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
  }
  button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }

  .ebook-preview {
    width: 100%;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    padding: 1rem;
    background: white;
    max-height: 600px;
    overflow-y: auto;
  }

  .ebook-preview :global(h1),
  .ebook-preview :global(h2),
  .ebook-preview :global(h3) {
    color: #111827;
    margin-top: 1rem;
    margin-bottom: 0.5rem;
  }

  .ebook-preview :global(p) {
    color: #374151;
    line-height: 1.6;
    margin: 0.5rem 0;
  }

  .ebook-chapters {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .chapter {
    padding: 1rem;
    background: #f9fafb;
    border-left: 4px solid #4f46e5;
    border-radius: 4px;
  }

  .chapter h6 {
    margin: 0 0 0.5rem 0;
    color: #374151;
    font-size: 1rem;
    font-weight: 600;
  }

  .chapter p {
    margin: 0;
    color: #6b7280;
    font-size: 0.95rem;
    line-height: 1.5;
  }
</style>
