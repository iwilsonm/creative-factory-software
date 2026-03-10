/**
 * build-agents.js — Parse agency-agents repo into agents.json
 *
 * Usage:
 *   node backend/data/build-agents.js /path/to/agency-agents
 *
 * If no path provided, defaults to /tmp/agency-agents
 * (clone first: git clone --depth 1 https://github.com/msitarzewski/agency-agents.git /tmp/agency-agents)
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';

const REPO_PATH = process.argv[2] || '/tmp/agency-agents';

// Division directories to scan (skip non-agent dirs like scripts, examples, strategy, integrations)
const DIVISION_DIRS = [
  'design',
  'engineering',
  'game-development',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'spatial-computing',
  'specialized',
  'support',
  'testing',
];

// Human-friendly labels for divisions
const DIVISION_LABELS = {
  'design': 'Design',
  'engineering': 'Engineering',
  'game-development': 'Game Development',
  'marketing': 'Marketing',
  'paid-media': 'Paid Media',
  'product': 'Product',
  'project-management': 'Project Management',
  'spatial-computing': 'Spatial Computing',
  'specialized': 'Specialized',
  'support': 'Support',
  'testing': 'Testing',
};

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const frontmatter = {};
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  const body = content.slice(match[0].length);
  return { frontmatter, body };
}

function buildAgents() {
  const divisions = [];
  const agents = [];

  for (const divDir of DIVISION_DIRS) {
    const dirPath = join(REPO_PATH, divDir);
    let files;
    try {
      files = readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    } catch {
      console.warn(`Skipping missing directory: ${divDir}`);
      continue;
    }

    const divAgents = [];

    for (const file of files) {
      const filePath = join(dirPath, file);
      if (!statSync(filePath).isFile()) continue;

      const content = readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      const id = basename(file, '.md');
      const agent = {
        id,
        name: frontmatter.name || id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: frontmatter.description || '',
        color: frontmatter.color || 'blue',
        emoji: frontmatter.emoji || '',
        vibe: frontmatter.vibe || '',
        division: divDir,
        systemPrompt: body.trim(),
      };

      divAgents.push(agent);
      agents.push(agent);
    }

    if (divAgents.length > 0) {
      divisions.push({
        id: divDir,
        label: DIVISION_LABELS[divDir] || divDir,
        agentCount: divAgents.length,
      });
    }
  }

  return { divisions, agents };
}

const data = buildAgents();

const outPath = join(import.meta.dirname, 'agents.json');
writeFileSync(outPath, JSON.stringify(data, null, 2));

console.log(`Written ${data.agents.length} agents across ${data.divisions.length} divisions to ${outPath}`);
for (const div of data.divisions) {
  console.log(`  ${div.label}: ${div.agentCount} agents`);
}
