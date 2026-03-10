/**
 * agencyTools.js — Toggleable tool definitions + handlers for the AI Agency chat.
 *
 * Each tool has:
 *   - category: 'read' | 'create' (for UI grouping)
 *   - definition: Claude tool_use schema (name, description, input_schema)
 *   - handler: async (projectId, input) => result
 */

import {
  getProject,
  getAdsByProject,
  getBatchesByProject,
  getQuoteBankByProject,
  getLandingPageSummariesByProject,
} from '../convexClient.js';
import { getCostSummary } from './costTracker.js';
import { generateImage } from './gemini.js';

export const AGENCY_TOOLS = {
  read_project_data: {
    category: 'read',
    label: 'Project Data',
    definition: {
      name: 'read_project_data',
      description: 'Get project details including product name, URL, description, and key settings. Use this to understand the product and project context.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: async (projectId) => {
      const p = await getProject(projectId);
      if (!p) return { error: 'Project not found' };
      return {
        name: p.name,
        url: p.url,
        description: p.description,
        product_type: p.product_type,
        target_audience: p.target_audience,
        status: p.status,
      };
    },
  },

  search_ads: {
    category: 'read',
    label: 'Search Ads',
    definition: {
      name: 'search_ads',
      description: 'Search and list ad creatives for this project. Returns headlines, primary text, status, and creation date. Limited to most recent 25 ads.',
      input_schema: {
        type: 'object',
        properties: {
          status_filter: {
            type: 'string',
            description: 'Optional status filter: "completed", "failed", "generating"',
          },
          limit: {
            type: 'number',
            description: 'Max ads to return (default 25)',
          },
        },
        required: [],
      },
    },
    handler: async (projectId, input) => {
      let ads = await getAdsByProject(projectId);
      if (input.status_filter) {
        ads = ads.filter(a => a.status === input.status_filter);
      }
      const limit = Math.min(input.limit || 25, 50);
      return {
        total: ads.length,
        ads: ads.slice(0, limit).map(a => ({
          headline: a.headline,
          primary_text: a.primary_text ? a.primary_text.slice(0, 300) : '',
          status: a.status,
          angle: a.angle,
          created_at: a.created_at,
        })),
      };
    },
  },

  search_quotes: {
    category: 'read',
    label: 'Quote Bank',
    definition: {
      name: 'search_quotes',
      description: 'Search the quote bank for emotional quotes mined from online communities. Returns quote text, source, tags, and generated headlines.',
      input_schema: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: 'Optional keyword to filter quotes by content',
          },
          limit: {
            type: 'number',
            description: 'Max quotes to return (default 20)',
          },
        },
        required: [],
      },
    },
    handler: async (projectId, input) => {
      let quotes = await getQuoteBankByProject(projectId);
      if (input.keyword) {
        const kw = input.keyword.toLowerCase();
        quotes = quotes.filter(q =>
          (q.text && q.text.toLowerCase().includes(kw)) ||
          (q.source && q.source.toLowerCase().includes(kw))
        );
      }
      const limit = Math.min(input.limit || 20, 50);
      return {
        total: quotes.length,
        quotes: quotes.slice(0, limit).map(q => ({
          text: q.text,
          source: q.source,
          emotion: q.emotion,
          tags: q.tags,
          headlines: q.headlines,
        })),
      };
    },
  },

  get_batch_status: {
    category: 'read',
    label: 'Batch Status',
    definition: {
      name: 'get_batch_status',
      description: 'Check the status of ad batch jobs for this project. Returns batch name, status, ad count, angle, and completion info.',
      input_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max batches to return (default 10)',
          },
        },
        required: [],
      },
    },
    handler: async (projectId, input) => {
      const batches = await getBatchesByProject(projectId);
      const limit = Math.min(input.limit || 10, 30);
      return {
        total: batches.length,
        batches: batches.slice(0, limit).map(b => ({
          name: b.name,
          status: b.status,
          ad_count: b.ad_count,
          completed_count: b.completed_count,
          failed_count: b.failed_count,
          angles: b.angles,
          created_at: b.created_at,
        })),
      };
    },
  },

  get_cost_summary: {
    category: 'read',
    label: 'Cost Summary',
    definition: {
      name: 'get_cost_summary',
      description: 'Pull API cost data for the project. Shows spending by service (OpenAI, Anthropic, Gemini) and by operation.',
      input_schema: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Number of days to look back (default 7)',
          },
        },
        required: [],
      },
    },
    handler: async (projectId) => {
      const summary = await getCostSummary(projectId);
      return summary;
    },
  },

  list_landing_pages: {
    category: 'read',
    label: 'Landing Pages',
    definition: {
      name: 'list_landing_pages',
      description: 'List landing pages for this project with their status, scores, and URLs.',
      input_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max LPs to return (default 10)',
          },
        },
        required: [],
      },
    },
    handler: async (projectId, input) => {
      const lps = await getLandingPageSummariesByProject(projectId);
      const limit = Math.min(input.limit || 10, 30);
      return {
        total: lps.length,
        landing_pages: lps.slice(0, limit).map(lp => ({
          name: lp.name,
          status: lp.status,
          gauntlet_score: lp.gauntlet_score,
          published_url: lp.published_url,
          angle: lp.angle,
          narrative_frame: lp.narrative_frame,
          created_at: lp.created_at,
        })),
      };
    },
  },

  generate_image: {
    category: 'create',
    label: 'Generate Image',
    definition: {
      name: 'generate_image',
      description: 'Generate an AI image using Gemini. The image will be displayed inline in the chat. Use detailed, descriptive prompts for best results.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed image generation prompt describing the desired image',
          },
          aspect_ratio: {
            type: 'string',
            enum: ['1:1', '9:16', '16:9'],
            description: 'Image aspect ratio (default 1:1)',
          },
        },
        required: ['prompt'],
      },
    },
    handler: async (projectId, input) => {
      const { imageBuffer, mimeType } = await generateImage(
        input.prompt,
        input.aspect_ratio || '1:1',
        null,
        { projectId, operation: 'agency_tool_generate_image' }
      );
      const base64 = imageBuffer.toString('base64');
      return {
        image_data: `data:${mimeType};base64,${base64}`,
        prompt_used: input.prompt,
        aspect_ratio: input.aspect_ratio || '1:1',
      };
    },
  },
};

/**
 * Get Claude tool definitions for a list of enabled tool IDs.
 */
export function getToolDefinitions(enabledToolIds) {
  if (!enabledToolIds || enabledToolIds.length === 0) return [];
  return enabledToolIds
    .filter(id => AGENCY_TOOLS[id])
    .map(id => AGENCY_TOOLS[id].definition);
}

/**
 * Execute a tool by name with the given project context and input.
 */
export async function executeTool(toolName, projectId, input) {
  const tool = AGENCY_TOOLS[toolName];
  if (!tool) throw new Error(`Unknown agency tool: ${toolName}`);
  return await tool.handler(projectId, input || {});
}

/**
 * Get tool catalog for the frontend (without handlers or full schemas).
 */
export function getToolCatalog() {
  return Object.entries(AGENCY_TOOLS).map(([id, tool]) => ({
    id,
    name: tool.definition.name,
    label: tool.label,
    description: tool.definition.description,
    category: tool.category,
  }));
}
