// Writing Callosium's MCP entry INTO the AI client's own config file, so
// connecting is a click instead of a JSON-editing exercise.
//
// This is exactly what ChatCut Desktop does, and why its connector appears with
// no credentials and no setup: its installer writes the entry for you. Read off a
// real machine, its entry is an ordinary stdio server —
//   { type: 'stdio', command: '...ChatCut/chatcut-mcp.cmd', args: [] }
// There is no port, no URL and no token, because stdio has no network surface for
// a token to protect. Ours already generates the same shape (mcpClientConfig);
// the only thing we were missing is putting it in the file.
//
// The token still matters to US — it carries attribution (which AI wrote a note)
// and scope (which folders that agent may read). Both survive being written into
// the config by us, which is why the owner never has to see or type it.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClientTarget {
  id: string;
  label: string;
  /** Absolute config path for this platform, or null when the client has none here. */
  file: string | null;
  /** Object key the server entry lives under. Every client we support uses mcpServers. */
  key: string;
  /** What the owner must do after we write, in their own words. */
  restart: string;
}

const home = (): string => os.homedir();

/** Claude Desktop keeps its config in the OS app-data dir, which differs per platform. */
function claudeDesktopFile(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home(), '.config', 'Claude', 'claude_desktop_config.json');
}

export function clientTargets(): ClientTarget[] {
  return [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      file: claudeDesktopFile(),
      key: 'mcpServers',
      restart: 'Quit Claude Desktop completely and open it again — it only reads this file at startup.',
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      file: path.join(home(), '.claude.json'),
      key: 'mcpServers',
      restart: 'Start a new Claude Code session — a running one keeps the old server list.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      file: path.join(home(), '.cursor', 'mcp.json'),
      key: 'mcpServers',
      restart: 'Restart Cursor, then check Settings → MCP shows callosium as connected.',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      file: path.join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
      key: 'mcpServers',
      restart: 'Restart Windsurf.',
    },
  ];
}

export function findClient(id: string): ClientTarget | undefined {
  return clientTargets().find((c) => c.id === id);
}

export interface InstallResult {
  file: string;
  created: boolean;
  backup: string | null;
  replacedExisting: boolean;
  otherServersKept: number;
  restart: string;
}

/**
 * Merge one server entry into a client's config, without disturbing anything else.
 *
 * Every rule here exists because this file is not ours. Claude Desktop's config on a
 * real machine also holds coworkUserFilesPath and preferences; Claude Code's ~/.claude.json
 * is tens of KB of unrelated state. Writing our object over either would destroy the lot,
 * so we read, merge one key, and put everything else back untouched.
 */
export async function installClientConfig(
  client: ClientTarget,
  serverName: string,
  entry: unknown,
): Promise<InstallResult> {
  if (!client.file) throw new Error(`${client.label} has no known config location on this platform.`);

  const existed = existsSync(client.file);
  let doc: Record<string, unknown> = {};

  if (existed) {
    const raw = await fs.readFile(client.file, 'utf8');
    if (raw.trim()) {
      try {
        doc = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        // REFUSE rather than repair. A config we cannot parse is a config someone
        // hand-edited or another tool is mid-write on; overwriting it would take out
        // every other connector they have to add one of ours.
        throw new Error(
          `${client.label}'s config is not valid JSON (${(err as Error).message}). ` +
            `Refusing to touch it — fix or move ${client.file} and try again.`,
        );
      }
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`${client.label}'s config is not a JSON object. Refusing to overwrite ${client.file}.`);
    }
  }

  const bucketRaw = doc[client.key];
  const bucket: Record<string, unknown> =
    bucketRaw && typeof bucketRaw === 'object' && !Array.isArray(bucketRaw)
      ? { ...(bucketRaw as Record<string, unknown>) }
      : {};
  const replacedExisting = Object.hasOwn(bucket, serverName);
  const otherServersKept = Object.keys(bucket).filter((k) => k !== serverName).length;

  // Back up BEFORE writing, and only when there was something to lose.
  let backup: string | null = null;
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${client.file}.callosium-backup-${stamp}`;
    await fs.copyFile(client.file, backup);
  }

  bucket[serverName] = entry;
  doc[client.key] = bucket;

  await fs.mkdir(path.dirname(client.file), { recursive: true });
  // temp + rename so a crash mid-write cannot leave a half-written config behind.
  const tmp = `${client.file}.callosium-tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, client.file);

  return { file: client.file, created: !existed, backup, replacedExisting, otherServersKept, restart: client.restart };
}
