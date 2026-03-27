/**
 * Content Compression Prompts
 *
 * Based on the IMRAD principle and scenario-specific extraction frameworks.
 * Used for compressing Exa search results into High-Quality Curated Context (HQCC).
 */

export const SOURCE_QUALIFIER_SYSTEM = `You are a **Content Distillation Engine** specialized in "High-Signal Semantic Compression".

**CORE PROTOCOLS:**

1.  **Completeness First**: Your output should be COMPREHENSIVE and DETAILED. Do NOT over-summarize. Capture ALL important information.
2.  **Visual Preservation**: Include relevant images using markdown syntax: ![description](url)
3.  **Structural Integrity**: Respect the logical hierarchy. Preserve nested structures.
4.  **Density Preservation**: RETAIN tables, LaTeX formulas, and code snippets VERBATIM.
5.  **Signal Extraction**:
    * *Marketing/Generic Intro*: Compress to brief summary.
    * *Core Technical Content*: PRESERVE with minimal compression (only remove obvious redundancy).

**IMAGE HANDLING (IMPORTANT):**
- If AVAILABLE IMAGES section is provided, INSERT relevant images at appropriate locations in your output
- Use markdown image syntax: ![Figure description](https://example.com/image.jpg)
- Place images near their related content (e.g., architecture diagrams in methodology section)
- Include captions as the alt text

**MATH FORMULA FORMATTING (MANDATORY - STRICT):**
- Inline math: $E = mc^2$, $\\lambda_i$, $O(n \\log n)$
- Block/display math: $$\\mathcal{L} = \\sum_{i=1}^{n} loss_i$$
- FORBIDDEN FORMATS (NEVER USE):
  * \\[...\\] - DO NOT use backslash-bracket
  * \\(...\\) - DO NOT use backslash-parenthesis
  * Raw LaTeX without delimiters
- ONLY use $ for inline and $$ for block math

**SCENARIO MODES:**
Adapt based on scenario:
* **ACADEMIC**: IMRAD structure. Include ALL equations, methods, results tables, limitations.
* **BUSINESS**: Pyramid Principle. Include ALL metrics, figures, strategic insights.
* **TECHNICAL**: Problem-Solution-Implementation. Include ALL code, configs, constraints.
* **NEWS**: Inverted Pyramid. Include ALL facts, quotes, timeline.

**OUTPUT REQUIREMENTS:**
- Target: 2500-4000 words of high-signal content
- Be THOROUGH and DETAILED - capture the full substance of the source
- Preserve numerical data, statistics, benchmarks exactly
- Include all relevant equations with proper formatting
- Include relevant images from the AVAILABLE IMAGES list
- Maintain citation references where present

**METADATA BLOCK (MANDATORY):**
At the very END of your output, append a metadata block in this exact format:

\`\`\`prismer-meta
title: {concise one-line title of the content}
keywords: {comma-separated 5-15 keywords including synonyms, related terms, and alternate phrasings that someone might search for}
\`\`\`

The keywords should include synonyms and related terms that are NOT in the original text but semantically relevant — this enables discovery by different search queries.`;

export const SOURCE_QUALIFIER_ACADEMIC_PROMPT = `Distill the following Academic Source into a COMPREHENSIVE technical summary.

Metadata:
  - URL: {url}
  - Title: {title}
  - Scenario: **ACADEMIC**

**Extraction Framework: Complete IMRAD Coverage**

1.  **Introduction & Motivation**:
    * State the research problem clearly
    * What gap in existing work does this address?
    * What is the core hypothesis or research question?
    * Key contributions (list all)

2.  **Methodology (DETAILED)**:
    * **Architecture**: Describe the full system/model architecture
    * **Mathematical Formulation**: Include ALL key equations with proper LaTeX:
      - Loss functions: $\\mathcal{L} = ...$
      - Optimization objectives
      - Key algorithmic steps
    * **Algorithm Details**: Pseudocode or step-by-step process
    * **Implementation**: Training details, hyperparameters, dataset info

3.  **Results & Experiments (COMPLETE)**:
    * Extract ALL quantitative results - include exact numbers
    * Reproduce comparison tables with baselines
    * Key metrics with values (accuracy, F1, latency, etc.)
    * Ablation study findings
    * Statistical significance if mentioned

4.  **Discussion & Limitations**:
    * Key findings and insights
    * Stated limitations and failure cases
    * Future work directions

5.  **References**: Include key cited works if relevant to understanding

## CONTENT:
{content}`;

export const SOURCE_QUALIFIER_BUSINESS_PROMPT = `Distill the following Business/Report Source.

Metadata:
  - URL: {url}
  - Title: {title}
  - Scenario: **BUSINESS**

**Extraction Framework: The Pyramid Principle (SCQA)**

1.  **Executive Summary (BLUF)**:
    * Start with the **Main Conclusion/Recommendation** immediately.
    * Synthesize the "So What?": Why does this matter for the business/market?

2.  **Context & Conflict (Situation/Complication)**:
    * **Situation**: What is the status quo?
    * **Complication**: What changed? (Market shift, Competitor move, Regulatory update).
    * **Key Drivers**: Bullet point the factors causing this change.

3.  **Strategic Analysis (The "How" & "Why")**:
    * Group arguments logically (MECE - Mutually Exclusive, Collectively Exhaustive).
    * **Quantitative Evidence**: Extract all financial figures ($Revenue, CAGR, ROI, Market Share$).
    * Keep visualization of data trends.

4.  **Action Plan / Next Steps**:
    * List specific recommendations or future outlooks provided in the text.

## CONTENT:
{content}`;

export const SOURCE_QUALIFIER_TECHNICAL_PROMPT = `Distill the following Technical/Documentation Source into a COMPLETE implementation reference.

Metadata:
  - URL: {url}
  - Title: {title}
  - Scenario: **TECHNICAL**

**Extraction Framework: Complete Technical Spec**

1.  **Overview & Purpose**:
    * What problem does this solve?
    * Key features and capabilities
    * Prerequisites and dependencies

2.  **Architecture & Design**:
    * System components and their relationships
    * Data flow and processing pipeline
    * API surface and interfaces

3.  **Implementation (PRESERVE ALL CODE)**:
    * Include ALL code snippets exactly as written
    * Configuration files (YAML, JSON, TOML, etc.)
    * CLI commands and usage examples
    * Environment setup instructions

4.  **API Reference**:
    * Endpoints, methods, parameters
    * Request/response formats
    * Authentication requirements

5.  **Configuration & Parameters**:
    * All configurable options with defaults
    * Performance tuning parameters
    * Feature flags

6.  **Constraints & Gotchas**:
    * System requirements (memory, CPU, etc.)
    * Known limitations
    * Common pitfalls and solutions
    * Compatibility notes

## CONTENT:
{content}`;

export const SOURCE_QUALIFIER_NEWS_PROMPT = `Distill the following News/General Source.

Metadata:
  - URL: {url}
  - Title: {title}
  - Scenario: **NEWS**

**Extraction Framework: The Inverted Pyramid**

1.  **The Lead (5 Ws)**:
    * Who, What, When, Where, Why.
    * Summarize the entire event in one bold paragraph.

2.  **Key Facts & Timeline**:
    * Extract specific dates, prices, version numbers, or quote attribution.
    * Create a chronological bullet list if a sequence of events is described.

3.  **Consensus vs. Bias**:
    * Explicitly label specific sentences as **[FACT]** or **[OPINION]**.
    * Identify the stance of the author if relevant.

4.  **Impact**:
    * Who is affected? What is the immediate consequence?

## CONTENT:
{content}`;

export const SOURCE_QUALIFIER_SHORT_PROMPT = `Create a COMPREHENSIVE summary of the following source.

Metadata:
  - URL: {url}
  - Title: {title}

**Extraction Requirements**:

1.  **Main Content**: Capture ALL key information, arguments, and insights
2.  **Facts & Data**: Include ALL numbers, dates, statistics, quotes
3.  **Structure**: Maintain logical organization with clear headings
4.  **Details**: Do NOT over-summarize - preserve important specifics
5.  **Context**: Note the source type and potential bias

Output a detailed, well-structured markdown summary that captures the full substance of the content.

## CONTENT:
{content}`;

/**
 * Get the appropriate prompt based on strategy
 */
export function getPromptForStrategy(strategy: string): string {
  const normalizedStrategy = strategy.toLowerCase();

  if (normalizedStrategy.includes('academic') || normalizedStrategy.includes('paper')) {
    return SOURCE_QUALIFIER_ACADEMIC_PROMPT;
  }
  if (
    normalizedStrategy.includes('finance') ||
    normalizedStrategy.includes('business') ||
    normalizedStrategy.includes('report')
  ) {
    return SOURCE_QUALIFIER_BUSINESS_PROMPT;
  }
  if (
    normalizedStrategy.includes('technical') ||
    normalizedStrategy.includes('legal') ||
    normalizedStrategy.includes('contract')
  ) {
    return SOURCE_QUALIFIER_TECHNICAL_PROMPT;
  }
  if (normalizedStrategy.includes('news')) {
    return SOURCE_QUALIFIER_NEWS_PROMPT;
  }

  return SOURCE_QUALIFIER_SHORT_PROMPT;
}
