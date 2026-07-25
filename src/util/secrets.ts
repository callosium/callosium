// Owner-only permissions for the two files that hold secrets: the agent token
// registry (System/agents.json) and the license (~/.callosium/license.json).
//
// Both were written with node's default mode, which on a typical POSIX box lands
// at 0644 after umask — world-readable. agents.json is the worse of the two: it
// holds every AI's bearer token in the clear, and the HTTP transport
// authenticates by token alone, so any other local account could read the file
// and then drive the loopback MCP endpoint with that agent's full scope,
// including folders the owner deliberately kept private. "Your files never
// leave your machine" has to also mean other people ON the machine can't read
// the keys to them.
//
// Windows has no mode bits that chmod can express (fs.chmod only toggles the
// read-only flag there), so this is a no-op on win32 by design rather than by
// accident — NTFS ACLs already inherit per-user profile restrictions for
// %USERPROFILE%, and the vault lives wherever the user put it.

import { promises as fs } from 'node:fs';

/** Tighten a just-written secret file to owner read/write only.
 *
 *  Best-effort: a chmod can legitimately fail on a network share, a FAT/exFAT
 *  volume, or a synced folder, and failing the write there would break the
 *  product for a real setup to fix a threat that filesystem doesn't model
 *  anyway. The caller has already persisted the data; this only narrows access. */
export async function restrictToOwner(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  await fs.chmod(file, 0o600).catch(() => {});
}

/** Same for a directory that holds secret files (owner rwx only), so a new file
 *  dropped in later isn't listable by anyone else even before it's chmod'd. */
export async function restrictDirToOwner(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  await fs.chmod(dir, 0o700).catch(() => {});
}
