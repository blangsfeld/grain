#!/usr/bin/env npx tsx
/**
 * Grain MCP Server
 *
 * Exposes Grain's atom layer as MCP tools.
 * Any LLM that speaks MCP can query beliefs, tensions, quotes,
 * voice patterns, commitments, and meeting reads.
 *
 * Usage:
 *   npx tsx mcp/server.ts
 *
 * Claude Code config (~/.claude.json mcpServers):
 *   {
 *     "grain": {
 *       "command": "npx",
 *       "args": ["tsx", "/Users/ben/Documents/Apps/grain/mcp/server.ts"],
 *       "env": {}
 *     }
 *   }
 */

import * as path from "path";
import * as dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ─── Env ─────────────────────────────────────────

dotenv.config({ path: path.resolve(__dirname, "..", ".env.local") });

function getDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key);
}

// ─── Formatters ──────────────────────────────────

function formatAtom(a: Record<string, unknown>): string {
  const type = a.type as string;
  const content = a.content as Record<string, unknown>;
  const source = `${a.source_title || "Unknown"} (${a.source_date || "no date"})`;
  const entities = (a.entities as string[])?.join(", ") || "";

  switch (type) {
    case "belief":
      return `**BELIEF** [${content.class}/${content.confidence}]: "${content.statement}"\n  Evidence: ${content.evidence}\n  Rules out: ${content.rules_out}\n  Source: ${source}${entities ? `\n  People: ${entities}` : ""}`;

    case "tension":
      return `**TENSION**: Says "${content.stated}" / Acts "${content.actual}"\n  Gap: ${content.gap}\n  Breakthrough: ${content.breakthrough_condition}\n  Source: ${source}`;

    case "quote":
      return `**QUOTE** [${content.weight}]: "${content.text}" — ${content.speaker}\n  ${content.reasoning}\n  Source: ${source}`;

    case "voice":
      return `**VOICE**: "${content.quote}"\n  Why it works: ${content.why_it_works}\n  Use for: ${content.use_it_for}\n  Source: ${source}`;

    case "commitment":
      return `**COMMITMENT** [${content.conviction}]: ${content.person || "Someone"} — ${content.statement}${content.due_date ? ` (by ${content.due_date})` : ""}\n  Source: ${source}`;

    case "read":
      return `**READ** — ${source}\n  ${content.the_read}`;

    default:
      return `**${type.toUpperCase()}**: ${JSON.stringify(content).slice(0, 200)}`;
  }
}

// ─── Server ──────────────────────────────────────

const server = new Server(
  { name: "grain", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ─── Tools ───────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "grain_query_atoms",
      description:
        "Query Grain's intelligence atoms. Filter by type (belief, tension, quote, voice, commitment, read), person name, domain, date range. Returns formatted atoms with source attribution.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            description: "Atom type filter. Comma-separated for multiple: belief,tension,quote,voice,commitment,read",
          },
          person: {
            type: "string",
            description: "Person name to filter by (searches entities array)",
          },
          domain: {
            type: "string",
            description: "Domain/company name to filter by",
          },
          since: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
          },
          until: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
          },
          search: {
            type: "string",
            description: "Full-text search across atom content",
          },
          limit: {
            type: "number",
            description: "Max results (default 20)",
          },
        },
      },
    },
    {
      name: "grain_beliefs",
      description:
        "Get all beliefs — the user's operating philosophy. Optionally filter by confidence (strong/moderate/emerging) or class (stated/implied/aspirational).",
      inputSchema: {
        type: "object" as const,
        properties: {
          confidence: { type: "string", description: "Filter: strong, moderate, or emerging" },
          class: { type: "string", description: "Filter: stated, implied, or aspirational" },
          limit: { type: "number", description: "Max results (default 30)" },
        },
      },
    },
    {
      name: "grain_tensions",
      description:
        "Get active tensions — gaps between what's stated and what behavior reveals. The structural dynamics in the user's world.",
      inputSchema: {
        type: "object" as const,
        properties: {
          domain: { type: "string", description: "Filter by domain/company" },
          since: { type: "string", description: "Start date (YYYY-MM-DD)" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
    {
      name: "grain_voice",
      description:
        "Get the user's captured verbal frameworks — compressions, reframes, metaphors, philosophy captures. Includes coaching notes on why each works and where to deploy it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          since: { type: "string", description: "Start date (YYYY-MM-DD)" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
    {
      name: "grain_commitments",
      description:
        "Get commitments and follow-ups. Who owes what to whom, with conviction level (firm/soft/aspirational).",
      inputSchema: {
        type: "object" as const,
        properties: {
          person: { type: "string", description: "Filter by person who owns the commitment" },
          conviction: { type: "string", description: "Filter: firm, soft, or aspirational" },
          limit: { type: "number", description: "Max results (default 30)" },
        },
      },
    },
    {
      name: "grain_weekly_digest",
      description:
        "Get the latest weekly digest — themes, tensions, beliefs, voice patterns, and emerging narratives synthesized across a week of meetings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          week: { type: "string", description: "Specific week file (e.g. 2026-W14). Omit for latest." },
        },
      },
    },
    {
      name: "grain_stats",
      description: "Get Grain corpus statistics — atom counts by type, date range, meeting count.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

// ─── Tool handlers ───────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const db = getDb();

  try {
    switch (name) {
      case "grain_query_atoms": {
        let query = db
          .from("dx_atoms")
          .select("*")
          .eq("archived", false)
          .order("source_date", { ascending: false })
          .limit((args?.limit as number) || 20);

        if (args?.type) {
          const types = (args.type as string).split(",").map((t) => t.trim());
          query = types.length === 1 ? query.eq("type", types[0]) : query.in("type", types);
        }
        if (args?.person) {
          query = query.contains("entities", [args.person as string]);
        }
        if (args?.domain) {
          query = query.ilike("domain", `%${args.domain}%`);
        }
        if (args?.since) {
          query = query.gte("source_date", args.since as string);
        }
        if (args?.until) {
          query = query.lte("source_date", args.until as string);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        let results = (data || []) as Record<string, unknown>[];

        // Client-side text search if requested
        if (args?.search) {
          const term = (args.search as string).toLowerCase();
          results = results.filter((a) =>
            JSON.stringify(a.content).toLowerCase().includes(term)
          );
        }

        const formatted = results.map(formatAtom).join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: results.length > 0
                ? `Found ${results.length} atoms:\n\n${formatted}`
                : "No atoms found matching your query.",
            },
          ],
        };
      }

      case "grain_beliefs": {
        let query = db
          .from("dx_atoms")
          .select("*")
          .eq("type", "belief")
          .eq("archived", false)
          .order("source_date", { ascending: false })
          .limit((args?.limit as number) || 30);

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        let results = (data || []) as Record<string, unknown>[];
        if (args?.confidence) {
          results = results.filter(
            (a) => (a.content as Record<string, unknown>).confidence === args.confidence
          );
        }
        if (args?.class) {
          results = results.filter(
            (a) => (a.content as Record<string, unknown>).class === args.class
          );
        }

        const formatted = results.map(formatAtom).join("\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: results.length > 0
                ? `${results.length} beliefs:\n\n${formatted}`
                : "No beliefs found.",
            },
          ],
        };
      }

      case "grain_tensions": {
        let query = db
          .from("dx_atoms")
          .select("*")
          .eq("type", "tension")
          .eq("archived", false)
          .order("source_date", { ascending: false })
          .limit((args?.limit as number) || 20);

        if (args?.domain) {
          query = query.ilike("domain", `%${args.domain}%`);
        }
        if (args?.since) {
          query = query.gte("source_date", args.since as string);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        const formatted = (data || []).map((a) => formatAtom(a as Record<string, unknown>)).join("\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: data?.length
                ? `${data.length} tensions:\n\n${formatted}`
                : "No tensions found.",
            },
          ],
        };
      }

      case "grain_voice": {
        let query = db
          .from("dx_atoms")
          .select("*")
          .eq("type", "voice")
          .eq("archived", false)
          .order("source_date", { ascending: false })
          .limit((args?.limit as number) || 20);

        if (args?.since) {
          query = query.gte("source_date", args.since as string);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        const formatted = (data || []).map((a) => formatAtom(a as Record<string, unknown>)).join("\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: data?.length
                ? `${data.length} voice atoms:\n\n${formatted}`
                : "No voice atoms found.",
            },
          ],
        };
      }

      case "grain_commitments": {
        let query = db
          .from("dx_atoms")
          .select("*")
          .eq("type", "commitment")
          .eq("archived", false)
          .order("source_date", { ascending: false })
          .limit((args?.limit as number) || 30);

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        let results = (data || []) as Record<string, unknown>[];
        if (args?.person) {
          const term = (args.person as string).toLowerCase();
          results = results.filter((a) => {
            const person = (a.content as Record<string, unknown>).person as string | null;
            return person?.toLowerCase().includes(term);
          });
        }
        if (args?.conviction) {
          results = results.filter(
            (a) => (a.content as Record<string, unknown>).conviction === args.conviction
          );
        }

        const formatted = results.map(formatAtom).join("\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text: results.length > 0
                ? `${results.length} commitments:\n\n${formatted}`
                : "No commitments found.",
            },
          ],
        };
      }

      case "grain_weekly_digest": {
        const fs = await import("fs");
        const weeklyDir = path.join(
          process.env.HOME || "",
          "Documents/Obsidian/Studio/40-patterns/weekly"
        );

        if (args?.week) {
          const filePath = path.join(weeklyDir, `${args.week}.md`);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            return { content: [{ type: "text" as const, text: content }] };
          } catch {
            return {
              content: [{ type: "text" as const, text: `No digest found for ${args.week}.` }],
            };
          }
        }

        // Get latest
        try {
          const files = fs.readdirSync(weeklyDir).filter((f: string) => f.endsWith(".md")).sort();
          if (files.length === 0) {
            return { content: [{ type: "text" as const, text: "No weekly digests found." }] };
          }
          const latest = files[files.length - 1];
          const content = fs.readFileSync(path.join(weeklyDir, latest), "utf-8");
          return { content: [{ type: "text" as const, text: content }] };
        } catch {
          return { content: [{ type: "text" as const, text: "Could not read weekly digests." }] };
        }
      }

      case "grain_stats": {
        const { data, error } = await db.rpc("grain_stats").single().catch(() => ({
          data: null,
          error: { message: "rpc not found" },
        }));

        // Fallback: manual query
        const { data: counts } = await db
          .from("dx_atoms")
          .select("type")
          .eq("archived", false);

        const typeCounts: Record<string, number> = {};
        for (const row of counts || []) {
          const t = (row as Record<string, unknown>).type as string;
          typeCounts[t] = (typeCounts[t] || 0) + 1;
        }

        const { data: dateRange } = await db
          .from("dx_atoms")
          .select("source_date")
          .eq("archived", false)
          .order("source_date", { ascending: true })
          .limit(1);

        const { data: latestDate } = await db
          .from("dx_atoms")
          .select("source_date")
          .eq("archived", false)
          .order("source_date", { ascending: false })
          .limit(1);

        const total = Object.values(typeCounts).reduce((s, n) => s + n, 0);
        const earliest = (dateRange?.[0] as Record<string, unknown>)?.source_date || "unknown";
        const latest = (latestDate?.[0] as Record<string, unknown>)?.source_date || "unknown";

        const lines = [
          `# Grain Corpus Stats`,
          ``,
          `Total atoms: ${total}`,
          `Date range: ${earliest} to ${latest}`,
          ``,
          `## By Type`,
          ...Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => `- ${type}: ${count}`),
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  }
});

// ─── Start ───────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Grain MCP server running on stdio");
}

main().catch(console.error);
