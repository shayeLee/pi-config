// Dedicated process keeps SDK lifetime and native descendants under agent-team's process group.
// No model call occurs when this module is imported by a test.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runClaude } from './runner.ts';

export async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error('Input too large');
    }
    const config = JSON.parse(input);
    if (typeof config.executable === 'string' && !existsSync(config.executable)) {
      emit({ type: 'claude_run_result', status: 'failed', errorMessage: `Claude Code executable not found: ${config.executable}; set PI_CLAUDE_EXECUTABLE.` });
      process.exitCode = 1;
      return;
    }
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    process.exitCode = await runClaude(config, query, emit, controller);
  } catch {
    emit({ type: 'claude_run_result', status: 'failed', errorMessage: 'Claude SDK worker could not start; check its installation and configuration.' });
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
