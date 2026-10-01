/** Cuts long tool output so it doesn't flood the model's context window. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} more characters]`;
}

/**
 * Marks content from outside the user (web pages, files) as data, not instructions.
 * The system prompt tells the model never to follow instructions inside these tags.
 * Closing tags inside the content are neutralized so it can't "escape" the wrapper.
 */
export function untrusted(source: string, content: string): string {
  const safe = content.replaceAll(/<\/?untrusted[^>]*>/gi, "[tag removed]");
  return `<untrusted source="${source}">\n${safe}\n</untrusted>`;
}
