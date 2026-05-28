/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {CdpSessionProvider} from './CdpSessionProvider.js';
import type {BrowserContext, Page} from './third_party/index.js';

/**
 * A rule for intercepting and modifying network responses.
 */
export interface InterceptRule {
  id: string;
  urlPattern: string; // substring match (case-insensitive)
  resourceType?: string; // 'Script' | 'Document' | 'Stylesheet' | etc.
  replacement?: string; // static replacement body
  transform?: string; // JS function body: (body: string) => string
}

/**
 * FetchInterceptor intercepts network responses via CDP Fetch domain.
 * Similar in architecture to WebSocketCollector — event-driven, per-page setup.
 *
 * WARNING: Fetch.enable activates a CDP domain that anti-bot systems can detect.
 * Use only when network-level interception is required.
 */
export class FetchInterceptor {
  #context: BrowserContext;
  #sessionProvider: CdpSessionProvider;
  #rules = new Map<string, InterceptRule>();
  #activePages = new WeakSet<Page>();
  #cdpCleanup = new WeakMap<Page, () => void>();

  constructor(
    context: BrowserContext,
    sessionProvider: CdpSessionProvider,
  ) {
    this.#context = context;
    this.#sessionProvider = sessionProvider;
  }

  /**
   * Add an interception rule. Activates Fetch domain for all active pages.
   */
  async addRule(rule: InterceptRule): Promise<void> {
    this.#rules.set(rule.id, rule);
    // Activate for all existing pages
    for (const page of this.#context.pages()) {
      if (!page.url().startsWith('devtools://')) {
        await this.#setupForPage(page);
      }
    }
  }

  /**
   * Remove an interception rule by ID.
   */
  async removeRule(id: string): Promise<void> {
    this.#rules.delete(id);
    // If no rules left, disable Fetch for all pages
    if (this.#rules.size === 0) {
      for (const page of this.#context.pages()) {
        this.#cleanupPage(page);
      }
    }
  }

  /**
   * Get all active interception rules.
   */
  getRules(): InterceptRule[] {
    return Array.from(this.#rules.values());
  }

  /**
   * Set up Fetch interception for a specific page.
   * Idempotent — safe to call multiple times.
   */
  async #setupForPage(page: Page): Promise<void> {
    if (this.#rules.size === 0) return;
    if (this.#activePages.has(page)) return;

    try {
      const client = await this.#sessionProvider.getSession(page);

      await client.send('Fetch.enable', {
        patterns: [{requestStage: 'Response'}],
        handleAuthRequests: false,
      });

      const onRequestPaused = async (
        event: {
          requestId: string;
          request: {url: string};
          resourceType: string;
          responseStatusCode?: number;
          responseHeaders?: Array<{name: string; value: string}>;
        },
      ): Promise<void> => {
        await this.#handleRequestPaused(client, event);
      };

      client.on('Fetch.requestPaused' as any, onRequestPaused);

      this.#activePages.add(page);
      this.#cdpCleanup.set(page, () => {
        client.off('Fetch.requestPaused' as any, onRequestPaused);
      });
    } catch (error) {
      logger('FetchInterceptor setup failed for page', error);
    }
  }

  /**
   * Handle a paused request — check rules, potentially modify response.
   */
  async #handleRequestPaused(
    client: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    event: {
      requestId: string;
      request: {url: string};
      resourceType: string;
      responseStatusCode?: number;
      responseHeaders?: Array<{name: string; value: string}>;
    },
  ): Promise<void> {
    const {requestId, request, resourceType} = event;
    const url = request.url;

    // Find matching rule
    const matchingRule = this.#findMatchingRule(url, resourceType);

    if (!matchingRule) {
      // No rule matches — continue the request unmodified
      try {
        await client.send('Fetch.continueResponse', {requestId});
      } catch {
        // Request may have already been handled
      }
      return;
    }

    try {
      // Get the original response body
      const bodyResult = await client.send('Fetch.getResponseBody', {
        requestId,
      });
      let body = bodyResult.body;
      const isBase64 = bodyResult.base64Encoded;

      // Decode if base64
      if (isBase64) {
        body = Buffer.from(body, 'base64').toString('utf-8');
      }

      // Apply transformation
      let newBody: string;
      if (matchingRule.replacement !== undefined) {
        newBody = matchingRule.replacement;
      } else if (matchingRule.transform) {
        // Execute the transform function
        const fn = new Function('body', matchingRule.transform);
        newBody = fn(body) as string;
      } else {
        // No modification — continue
        await client.send('Fetch.continueResponse', {requestId});
        return;
      }

      // Fulfill with modified response
      await client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: event.responseStatusCode ?? 200,
        responseHeaders: event.responseHeaders ?? [],
        body: Buffer.from(newBody).toString('base64'),
      });

      logger(
        `FetchInterceptor: intercepted ${url} (${matchingRule.id})`,
      );
    } catch (error) {
      // If anything goes wrong, try to continue unmodified
      try {
        await client.send('Fetch.continueResponse', {requestId});
      } catch {
        // Give up silently
      }
      logger('FetchInterceptor: error handling request', error);
    }
  }

  /**
   * Find the first matching rule for a URL/resourceType.
   */
  #findMatchingRule(url: string, resourceType: string): InterceptRule | null {
    const lowerUrl = url.toLowerCase();
    for (const rule of this.#rules.values()) {
      if (!lowerUrl.includes(rule.urlPattern.toLowerCase())) {
        continue;
      }
      if (rule.resourceType && rule.resourceType !== resourceType) {
        continue;
      }
      return rule;
    }
    return null;
  }

  /**
   * Clean up Fetch interception for a page.
   */
  #cleanupPage(page: Page): void {
    const cleanup = this.#cdpCleanup.get(page);
    if (cleanup) {
      try {
        cleanup();
      } catch {
        // Ignore
      }
    }
    this.#cdpCleanup.delete(page);
    this.#activePages.delete(page);

    // Try to disable Fetch domain
    this.#sessionProvider
      .getSession(page)
      .then(client => client.send('Fetch.disable').catch(() => {}))
      .catch(() => {});
  }
}
