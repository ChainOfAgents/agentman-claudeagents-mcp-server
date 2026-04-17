/**
 * Template loader for bundled agent templates.
 *
 * Templates are YAML files in src/templates/ that define common
 * Claude Managed Agents agent configurations. They're loaded once at
 * module init and exposed via the claudeagent_list_templates and
 * claudeagent_get_template tools.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { logger } from "../utils/logger.js";

// =============================================================================
// Template types
// =============================================================================

/**
 * The shape of a bundled template file.
 */
export interface TemplateFile {
  slug: string;
  name: string;
  description: string;
  category: string;
  config: Record<string, unknown>;
}

// =============================================================================
// Load templates at module init
// =============================================================================

function resolveTemplatesDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // src/services/templates.ts -> ../templates (when running via tsx in dev)
  // dist/services/templates.js -> ../templates (when running compiled — dist/templates not copied,
  //   so we resolve upward to the package root)
  // We look in both src/templates and ../templates relative to the module.
  const candidates = [
    join(__dirname, "..", "templates"),
    join(__dirname, "..", "..", "src", "templates"),
  ];
  for (const candidate of candidates) {
    try {
      const files = readdirSync(candidate);
      if (files.some((f) => f.endsWith(".yaml"))) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  // Fallback — may not exist, readdirSync will throw
  return candidates[0];
}

function loadTemplates(): Map<string, TemplateFile> {
  const templates = new Map<string, TemplateFile>();
  const dir = resolveTemplatesDir();

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  } catch (err) {
    logger.warn(`Could not read templates directory at ${dir}`, { err });
    return templates;
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const parsed = YAML.parse(content) as TemplateFile;
      if (!parsed.slug || !parsed.name || !parsed.config) {
        logger.warn(`Template ${file} is missing required fields, skipping`);
        continue;
      }
      templates.set(parsed.slug, parsed);
    } catch (err) {
      logger.warn(`Failed to parse template ${file}`, { err });
    }
  }

  logger.info(`Loaded ${templates.size} agent templates from ${dir}`);
  return templates;
}

const TEMPLATES = loadTemplates();

// =============================================================================
// Public API
// =============================================================================

/**
 * List all bundled templates, optionally filtered by category.
 */
export function listTemplates(category?: string): TemplateFile[] {
  const all = Array.from(TEMPLATES.values());
  if (category) {
    return all.filter((t) => t.category === category);
  }
  return all;
}

/**
 * Get a template by slug. Returns undefined if not found.
 */
export function getTemplate(slug: string): TemplateFile | undefined {
  return TEMPLATES.get(slug);
}

/**
 * List all unique categories across loaded templates.
 */
export function listCategories(): string[] {
  const categories = new Set<string>();
  for (const t of TEMPLATES.values()) {
    categories.add(t.category);
  }
  return Array.from(categories).sort();
}
