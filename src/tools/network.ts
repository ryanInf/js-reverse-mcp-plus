/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Resource types as string literals (Playwright returns string from resourceType())
const FILTERABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'other',
] as const;

export const listNetworkRequests = defineTool({
  name: 'list_network_requests',
  description: `List network requests for the currently selected page since the last navigation. Results are sorted newest-first. By default returns the 20 most recent requests; use pageSize/pageIdx to paginate. Pass reqid to get a single request's full details.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of a specific network request to get full details for. If omitted, lists all requests.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of requests to return. Defaults to 20.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter requests by URL. Only requests containing this substring will be returned.',
      ),
    includePreservedRequests: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved requests over the last 3 navigations.',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.reqid !== undefined) {
      response.attachNetworkRequest(request.params.reqid);
      return;
    }
    const data = await context.getDevToolsData();
    const reqid = data?.cdpRequestId
      ? context.resolveCdpRequestId(data.cdpRequestId)
      : undefined;
    response.setIncludeNetworkRequests(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      resourceTypes: request.params.resourceTypes,
      urlFilter: request.params.urlFilter,
      includePreservedRequests: request.params.includePreservedRequests,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});

/**
 * Intercept and modify network responses via CDP Fetch domain.
 * Can intercept JS/CSS/HTML and any other resource, modifying
 * the response body before it reaches the page.
 *
 * WARNING: Fetch.enable activates a CDP domain that anti-bot systems
 * can detect. Use only when network-level interception is required.
 */
export const interceptResponse = defineTool({
  name: 'intercept_response',
  description:
    'Intercept and modify network responses via CDP Fetch domain. Can replace the entire response body for matching URLs or apply a JS transform function. WARNING: Fetch.enable activates a CDP domain that anti-bot systems can detect — use only when network-level interception is required.',
  annotations: {
    title: 'Intercept Response',
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum(['intercept', 'remove', 'list'])
      .describe('Action to perform.'),
    urlPattern: zod
      .string()
      .optional()
      .describe(
        'URL pattern to match (substring, case-insensitive). Required for intercept.',
      ),
    resourceType: zod
      .string()
      .optional()
      .describe(
        'Resource type filter: "Script", "Document", "Stylesheet", "XHR", "Fetch", etc.',
      ),
    replacement: zod
      .string()
      .optional()
      .describe(
        'Static replacement response body. Use this for complete replacements.',
      ),
    transform: zod
      .string()
      .optional()
      .describe(
        'JS function body to transform the response. Receives `body` (string) and must return a string. Example: "return body.replace(/old/g, \'new\')"',
      ),
    ruleId: zod
      .string()
      .optional()
      .describe('Rule ID. Auto-generated if not provided for intercept. Required for remove.'),
  },
  handler: async (request, response, context) => {
    const {action, urlPattern, resourceType, replacement, transform, ruleId} =
      request.params;
    const interceptor = context.fetchInterceptor;

    try {
      // List mode
      if (action === 'list') {
        const rules = interceptor.getRules();
        if (rules.length === 0) {
          response.appendResponseLine('No active interception rules.');
          return;
        }
        response.appendResponseLine(
          `Active interception rules (${rules.length}):\n`,
        );
        for (const rule of rules) {
          response.appendResponseLine(`- ID: ${rule.id}`);
          response.appendResponseLine(`  URL pattern: ${rule.urlPattern}`);
          if (rule.resourceType) {
            response.appendResponseLine(
              `  Resource type: ${rule.resourceType}`,
            );
          }
          if (rule.replacement !== undefined) {
            const preview =
              rule.replacement.length > 100
                ? rule.replacement.substring(0, 100) + '...'
                : rule.replacement;
            response.appendResponseLine(`  Replacement: ${preview}`);
          } else if (rule.transform) {
            response.appendResponseLine(`  Transform: ${rule.transform}`);
          }
          response.appendResponseLine('');
        }
        return;
      }

      // Remove mode
      if (action === 'remove') {
        if (!ruleId) {
          response.appendResponseLine('ruleId is required for remove action.');
          return;
        }
        await interceptor.removeRule(ruleId);
        response.appendResponseLine(`Interception rule removed: ${ruleId}`);
        return;
      }

      // Intercept mode
      if (!urlPattern) {
        response.appendResponseLine(
          'urlPattern is required for intercept action.',
        );
        return;
      }
      if (!replacement && !transform) {
        response.appendResponseLine(
          'Either replacement or transform must be provided.',
        );
        return;
      }

      const id = ruleId || `intercept_${Date.now()}`;
      await interceptor.addRule({
        id,
        urlPattern,
        resourceType,
        replacement,
        transform,
      });
      response.appendResponseLine(`✅ Interception rule added. ID: ${id}`);
      response.appendResponseLine(`  URL pattern: ${urlPattern}`);
      if (resourceType) {
        response.appendResponseLine(`  Resource type: ${resourceType}`);
      }
      response.appendResponseLine(
        'Responses will be modified on the next request matching this pattern.',
      );
      response.appendResponseLine(
        `To remove: intercept_response(action: "remove", ruleId: "${id}")`,
      );
    } catch (error) {
      response.appendResponseLine(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});
