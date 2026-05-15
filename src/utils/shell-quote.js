/**
 * Minimal shell quoting utilities.
 * We only need to safely embed a command string into:
 *   sh -c "<command>"
 * This means escaping double quotes, backslashes, $, and backticks.
 */

// Characters that need escaping inside double-quoted POSIX strings
const ESCAPE_RE = /[$"\\`!]/g;

// Operators: if a line starts with these after trimming, treat as directive not command
const SHELL_OPERATORS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', '{', '}',
]);

/**
 * Quote a command for safe embedding in `sh -c "..."`.
 * Preserves multi-line commands, heredocs, etc.
 */
export function quoteCommand(command) {
  // Escape special chars inside double quotes
  const escaped = command.replace(ESCAPE_RE, '\\$&');
  return `"${escaped}"`;
}

/**
 * Check if stdin redirect should be added.
 * Various GNU tools (rg, grep, sort, etc.) wait on stdin when given piped input.
 */
export function shouldAddStdinRedirect(command) {
  const trimmed = command.trim();
  // Already has stdin redirect
  if (trimmed.includes('<')) return false;
  // Already has heredoc
  if (trimmed.includes('<<')) return false;
  // Check if first word is a shell keyword / flow control
  const firstWord = trimmed.split(/\s+/)[0];
  if (firstWord && SHELL_OPERATORS.has(firstWord)) return false;
  return true;
}

/**
 * Split compound shell commands by operators (&&, ||, ;, |, \n).
 * Used for excluded-command matching — each subcommand is checked individually.
 * This is NOT a full shell parser; edge cases (quoted operators) are possible.
 */
export function splitCompoundCommand(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inDollarParen = 0;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1] || '';

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      current += ch;
      if (ch === '"' && command[i - 1] !== '\\') inDouble = false;
      i++;
      continue;
    }

    // Track $(...) nesting to avoid splitting inside command substitution
    if (ch === '$' && next === '(') {
      inDollarParen++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')' && inDollarParen > 0) {
      inDollarParen--;
      current += ch;
      i++;
      continue;
    }

    if (ch === "'") { inSingle = true; current += ch; i++; continue; }
    if (ch === '"') { inDouble = true; current += ch; i++; continue; }

    if (inDollarParen === 0) {
      // Compound operators
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|') || (ch === ';' && next !== ';')) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i++;
        i++;
        continue;
      }
      if (ch === '|') {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        i++;
        continue;
      }
      if (ch === '\n') {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}
