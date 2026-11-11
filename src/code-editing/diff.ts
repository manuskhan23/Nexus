export interface TextDiff {
  lines: string[];
  truncated: boolean;
}

export function buildTextDiff(before: string, after: string, maxLines = 400): TextDiff {
  const beforeAll = before.split(/\r?\n/);
  const afterAll = after.split(/\r?\n/);
  const left = beforeAll.slice(0, maxLines);
  const right = afterAll.slice(0, maxLines);
  const width = right.length + 1;
  const lcs = new Uint16Array((left.length + 1) * width);

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const at = i * width + j;
      lcs[at] = left[i] === right[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push(`  ${left[i]}`);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      lines.push(`- ${left[i++]}`);
    } else {
      lines.push(`+ ${right[j++]}`);
    }
  }
  while (i < left.length) lines.push(`- ${left[i++]}`);
  while (j < right.length) lines.push(`+ ${right[j++]}`);

  return { lines, truncated: beforeAll.length > maxLines || afterAll.length > maxLines };
}
